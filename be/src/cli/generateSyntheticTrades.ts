import { createDatabase } from '../db/client.js';
import { upsertQuoteFeed } from '../market/quotePricing/feedRegistry.js';
import { upsertPriceRounds } from '../market/quotePricing/priceRounds.js';

export interface SyntheticTrade {
  chainId: number; tokenAddress: string; venueId: string; quoteAssetAddress: string;
  blockNumber: bigint; blockHash: string; txHash: string; logIndex: number; timestamp: number;
  side: 'buy' | 'sell'; tokenAmountRaw: string; quoteAmountRaw: string;
}

export function buildSyntheticTradeBatch(params: {
  chainId: number; tokenAddress: string; venueId: string; quoteAssetAddress: string;
  startBlock: bigint; count: number; startTimestamp: number;
}): readonly SyntheticTrade[] {
  const rows: SyntheticTrade[] = [];
  for (let i = 0; i < params.count; i++) {
    const blockNumber = params.startBlock + BigInt(i);
    const hex = blockNumber.toString(16).padStart(8, '0') + i.toString(16).padStart(8, '0');
    rows.push({
      chainId: params.chainId, tokenAddress: params.tokenAddress, venueId: params.venueId, quoteAssetAddress: params.quoteAssetAddress,
      blockNumber, blockHash: `0x${hex.padStart(64, '0')}`, txHash: `0x${hex.padStart(64, '1')}`, logIndex: 0,
      timestamp: params.startTimestamp + i, side: i % 2 === 0 ? 'buy' : 'sell',
      tokenAmountRaw: (1_000_000_000_000_000_000n + BigInt(i)).toString(), quoteAmountRaw: (10_000_000_000_000_000n + BigInt(i)).toString(),
    });
  }
  return rows;
}

// Chunked bulk insert respecting Postgres's real 65,535-bind-parameter protocol limit per query
// (be/src/db/chunk.ts, deleted with the old RPC-scan indexer, had this same logic — reimplemented
// locally here rather than reviving that file, per the plan's own instruction).
async function bulkInsertTrades(pool: { query(text: string, params: readonly unknown[]): Promise<unknown> }, rows: readonly SyntheticTrade[]): Promise<void> {
  const columnsPerRow = 14;
  const maxRowsPerChunk = Math.floor(60_000 / columnsPerRow);
  for (let start = 0; start < rows.length; start += maxRowsPerChunk) {
    const chunk = rows.slice(start, start + maxRowsPerChunk);
    const values: unknown[] = [];
    const placeholders = chunk.map((row, i) => {
      const base = i * columnsPerRow;
      values.push(row.chainId, row.tokenAddress, row.venueId, row.blockNumber.toString(), row.blockHash, row.txHash,
        row.logIndex, row.timestamp, row.side, row.tokenAmountRaw, row.quoteAmountRaw, row.quoteAssetAddress, 'SyntheticTrade', 'user_trade');
      return `(${Array.from({ length: columnsPerRow }, (_, j) => `$${base + j + 1}`).join(',')})`;
    });
    await pool.query(
      `INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp, side,
        token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind)
       VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const launchCount = Number(process.env.SYNTHETIC_LAUNCH_COUNT ?? 5000);
  const tradesPerLaunch = Number(process.env.SYNTHETIC_TRADES_PER_LAUNCH ?? 1100);
  const chainId = 4663;
  const quoteAsset = '0x5ead00000000000000000000000000000000ad';
  const feedAddress = '0x5eadfeed000000000000000000000000000ad2';
  const sourceId = 'synthetic-benchmark-source';
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 30 * 86_400;

  const { db, pool } = createDatabase(databaseUrl);
  void db;

  console.log(`Seeding ${launchCount} synthetic launches x ${tradesPerLaunch} trades each...`);

  await pool.query(
    `INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
     VALUES ($1, $2, 'v1', $3, 0, 0, 999999999, 'caught_up') ON CONFLICT (id) DO NOTHING`,
    [sourceId, chainId, quoteAsset],
  );

  await upsertQuoteFeed(pool as never, { chainId, quoteAssetAddress: quoteAsset as never, feedAddress: feedAddress as never,
    aggregatorAddress: null, discoverySource: 'synthetic-benchmark', verificationStatus: 'verified', now: new Date() });

  // One round every 3600s across the whole window — dense enough that every synthetic trade (one
  // per second) finds a round at or before its own position within the 24h freshness ceiling.
  const rounds = [];
  for (let t = windowStart; t <= now; t += 3600) {
    rounds.push({ roundId: BigInt(Math.floor((t - windowStart) / 3600) + 1), answerRaw: 300_000_000_000n, decimals: 8,
      startedAt: t, updatedAt: t, blockNumber: BigInt(Math.floor((t - windowStart) / 10)), logIndex: 0 });
  }
  await upsertPriceRounds(pool as never, chainId, feedAddress, rounds);

  for (let launchIndex = 0; launchIndex < launchCount; launchIndex++) {
    const suffix = launchIndex.toString(16).padStart(8, '0');
    const tokenAddress = `0x5ead${suffix}000000000000000000000000`;
    const venueId = `synthetic:v3_pool:${tokenAddress}`;
    await pool.query(
      `INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
        factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
        quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
       VALUES ($1,$2,$3,$4,$5,18,'pons','v1',$2,$2,1,$6,0,$7,'SYN',18,'trading') ON CONFLICT DO NOTHING`,
      [chainId, tokenAddress, sourceId, `Synthetic ${launchIndex}`, `SYN${launchIndex}`,
        `0x${suffix.padStart(64, '0')}`, quoteAsset],
    );
    await pool.query(
      `INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
       VALUES ($1,$2,$3,'v3_pool',$3,$4,0,true) ON CONFLICT DO NOTHING`,
      [venueId, chainId, tokenAddress, sourceId],
    );
    // Spread launches' trade windows evenly across the full 30-day span (not just day 1) — this
    // way a representative fraction of launches land their trades inside the real last-24h window
    // the volume24hUsd query actually scans, instead of every launch's trades sitting ~29-30 days
    // in the past and never matching that query's WHERE clause at all (found empirically: the first
    // seed run put zero synthetic trades inside the 24h window, so the benchmark measured the
    // all-empty path, not the real one).
    const totalWindowSeconds = 30 * 86_400;
    const startTimestamp = windowStart + Math.floor((launchIndex / launchCount) * (totalWindowSeconds - tradesPerLaunch));
    const trades = buildSyntheticTradeBatch({ chainId, tokenAddress, venueId, quoteAssetAddress: quoteAsset,
      startBlock: BigInt(launchIndex * 100_000), count: tradesPerLaunch, startTimestamp });
    await bulkInsertTrades(pool, trades);
    if (launchIndex % 500 === 0) console.log(`  ...${launchIndex}/${launchCount} launches seeded`);
  }

  console.log(`Done: ${launchCount} launches, ~${launchCount * tradesPerLaunch} trades.`);
  await pool.end();
}

const isMainModule = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMainModule) main();
