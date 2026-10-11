import { Pool } from 'pg';
import type { Address } from 'viem';
import { createRobinhoodPublicClient, robinhood } from '../chains/robinhood.js';
import { backfillRoundHistory, type RoundHistoryClient } from '../market/quotePricing/roundHistoryBackfill.js';

// Fills the USD oracle round history of every verified feed back to the first trade quoted in its asset, so old trades can be valued (Volume and
// USD candle history stop being "unavailable"). Resumable and safe to re-run. Afterwards run the candle / volume workers: storing a round marks the
// buckets it affects dirty and they recompute.
//   npm run -w be prices:backfill-history -- --concurrency 8 [--feed 0x...]
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const argument = (name: string): string | undefined => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? undefined : process.argv[index + 1]; };
const concurrency = Number(argument('concurrency') ?? 8);
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
const only = argument('feed')?.toLowerCase();
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com') as unknown as RoundHistoryClient;
try {
  const feeds = (await pool.query(`SELECT f.feed_address, min(t.timestamp)::bigint AS first_trade FROM quote_usd_feeds f
    JOIN trades t ON t.chain_id = f.chain_id AND t.quote_asset_address = f.quote_asset_address
    WHERE f.chain_id = $1 AND f.verification_status = 'verified' GROUP BY f.feed_address ORDER BY first_trade`, [robinhood.id])).rows
    .filter((row) => only === undefined || String(row.feed_address).toLowerCase() === only);
  console.log(`${feeds.length} feed(s) with trades to value`);
  const started = Date.now();
  for (const row of feeds) {
    const result = await backfillRoundHistory(client, pool, robinhood.id, row.feed_address as Address, Number(row.first_trade), {
      concurrency, log: (message) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`),
    });
    console.log(`feed ${row.feed_address}:`, result);
  }
} finally { await pool.end(); }
