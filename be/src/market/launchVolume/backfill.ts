import type { Pool } from 'pg';
import { valueTradeUsd } from '../quotePricing/tradeValuation.js';
import { refreshDueLaunchVolumes } from './worker.js';
import { markVolumeBackfillComplete } from './state.js';

const VOLUME_WINDOW_SECONDS = 86_400;

export interface BackfillOptions {
  now: Date;
  batchSize: number;
  maxIterations?: number;
  readHead: () => Promise<bigint | null>;
}

export interface BackfillResult { complete: boolean; iterations: number; published: number; failed: number }

export async function countMissingLaunchVolumes(pool: Pool): Promise<number> {
  const result = await pool.query(`
    SELECT count(*)::int AS n FROM launches l
    WHERE NOT EXISTS (SELECT 1 FROM launch_volume24h_usd s WHERE s.chain_id = l.chain_id AND s.token_address = l.token_address)`);
  return result.rows[0].n;
}

// Newest launches first, so the ones users are most likely to look at become rankable soonest.
async function enqueueMissingLaunchVolumes(pool: Pool, now: Date, limit: number): Promise<void> {
  await pool.query(`
    INSERT INTO launch_volume24h_jobs (chain_id, token_address, revision, due_at)
    SELECT l.chain_id, l.token_address, 1, $1::timestamptz FROM launches l
    WHERE NOT EXISTS (SELECT 1 FROM launch_volume24h_usd s WHERE s.chain_id = l.chain_id AND s.token_address = l.token_address)
      AND NOT EXISTS (SELECT 1 FROM launch_volume24h_jobs j WHERE j.chain_id = l.chain_id AND j.token_address = l.token_address)
    ORDER BY l.launch_block DESC, l.launch_tx_hash DESC, l.launch_log_index DESC
    LIMIT $2
    ON CONFLICT DO NOTHING`, [now, limit]);
}

// Resumable by construction: progress is the set of launches without a score row, so an interrupted run
// simply continues where the next run finds work, and finished launches are never rescored.
export async function runVolumeBackfill(pool: Pool, options: BackfillOptions): Promise<BackfillResult> {
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const result: BackfillResult = { complete: false, iterations: 0, published: 0, failed: 0 };
  while (result.iterations < maxIterations) {
    result.iterations += 1;
    await enqueueMissingLaunchVolumes(pool, options.now, options.batchSize);
    const report = await refreshDueLaunchVolumes(pool, options.now, options.batchSize, options.readHead);
    result.published += report.published;
    result.failed += report.failed;
    if (report.failed > 0) break;
    if (await countMissingLaunchVolumes(pool) === 0) break;
  }
  result.complete = await countMissingLaunchVolumes(pool) === 0;
  if (result.complete) await markVolumeBackfillComplete(pool, options.now);
  return result;
}

export interface ReconcileMismatch { tokenAddress: string; stored: string | null; recomputed: string | null }
export interface ReconcileReport { checked: number; mismatches: ReconcileMismatch[] }

// Independent check: recompute each sampled launch with the trade-page valuation rule (valueTradeUsd, one
// trade at a time) instead of the set-based arithmetic the worker uses, so a shared bug cannot hide itself.
export async function reconcileLaunchVolumes(pool: Pool, options: { sampleSize: number; now: Date }): Promise<ReconcileReport> {
  const sample = await pool.query(`
    SELECT s.chain_id, s.token_address, s.volume_usd, s.window_end, s.completeness_reason, l.quote_asset_address, l.quote_asset_decimals
    FROM launch_volume24h_usd s JOIN launches l ON l.chain_id = s.chain_id AND l.token_address = s.token_address
    ORDER BY random() LIMIT $1`, [options.sampleSize]);
  const report: ReconcileReport = { checked: 0, mismatches: [] };
  for (const row of sample.rows) {
    if (row.completeness_reason === 'incomplete_coverage') continue;
    const windowEnd = Number(row.window_end);
    const trades = await pool.query(`
      SELECT t.quote_amount_raw, t.timestamp, t.block_number, t.log_index
      FROM venues v JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
      WHERE v.chain_id = $1 AND v.token_address = $2 AND v.official = true
        AND t.timestamp >= $3 AND t.timestamp <= $4`,
    [row.chain_id, row.token_address, windowEnd - VOLUME_WINDOW_SECONDS, windowEnd]);
    let total = 0;
    let recomputed: string | null = '0';
    for (const trade of trades.rows) {
      const valuation = await valueTradeUsd(pool, row.chain_id, row.quote_asset_address, {
        timestamp: Number(trade.timestamp), quoteAmountRaw: BigInt(trade.quote_amount_raw),
        quoteAssetDecimals: row.quote_asset_decimals, blockNumber: BigInt(trade.block_number), logIndex: trade.log_index,
      });
      if (valuation.status !== 'priced') {
        recomputed = null;
        break;
      }
      total += Number(valuation.usdValue);
      recomputed = String(total);
    }
    report.checked += 1;
    const stored = row.volume_usd === null ? null : String(Number(row.volume_usd));
    const agree = stored === null || recomputed === null
      ? stored === recomputed
      : Math.abs(Number(stored) - Number(recomputed)) <= 1e-9 * Math.max(1, Math.abs(Number(stored)));
    if (!agree) report.mismatches.push({ tokenAddress: row.token_address, stored, recomputed });
  }
  return report;
}
