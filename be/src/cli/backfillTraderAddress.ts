import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { mapWithConcurrency, RPC_FETCH_CONCURRENCY } from '../indexer/concurrency.js';
import { retryDelayMs } from '../indexer/scan.js';

// One-off backfill for the `trader_address` column added after trades already existed. Replays
// purely from already-saved rows (tx_hash) plus a tx.origin lookup per unique hash — no
// eth_getLogs re-scan needed, since the trade rows and their provenance are already durable.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const { pool } = createDatabase(databaseUrl);
const client = createRobinhoodPublicClient(rpcUrl);

async function getTraderWithRetry(txHash: `0x${string}`, maxRetries = 6): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.getTransaction({ hash: txHash })).from;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(message, attempt)));
    }
  }
}

async function run(): Promise<void> {
  let totalHashes = 0;
  let totalRows = 0;
  for (;;) {
    const result = await pool.query<{ tx_hash: string }>(
      'SELECT DISTINCT tx_hash FROM trades WHERE trader_address IS NULL LIMIT 500',
    );
    if (result.rows.length === 0) break;
    const hashes = result.rows.map((row) => row.tx_hash as `0x${string}`);
    let entries: readonly (readonly [`0x${string}`, string])[];
    try {
      entries = await mapWithConcurrency(hashes, RPC_FETCH_CONCURRENCY,
        async (txHash) => [txHash, await getTraderWithRetry(txHash)] as const);
    } catch (error) {
      console.error(JSON.stringify({ batchError: error instanceof Error ? error.message : String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    for (const [txHash, trader] of entries) {
      const updated = await pool.query('UPDATE trades SET trader_address = $1 WHERE tx_hash = $2 AND trader_address IS NULL',
        [trader.toLowerCase(), txHash]);
      totalRows += updated.rowCount ?? 0;
    }
    totalHashes += hashes.length;
    console.log(JSON.stringify({ backfilledHashes: totalHashes, backfilledRows: totalRows }));
  }
  console.log(JSON.stringify({ done: true, totalHashes, totalRows }));
}

try {
  await run();
} finally {
  await pool.end();
}
