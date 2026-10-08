import type { Pool } from 'pg';
import { percentChange } from './valuation.js';

export const TVL_CHANGE_WINDOW_SECONDS = 86_400;
export const TVL_CHANGE_TOLERANCE_SECONDS = 7_200;

export interface TvlSnapshotInput {
  chainId: number; protocol: 'uniswap_v4'; poolId: string; blockNumber: bigint; capturedAtSeconds: number;
  coreAmount0Raw: bigint; coreAmount1Raw: bigint; sqrtPriceX96: bigint; quoteAddress: string; tvlUsd: string;
}

export async function insertTvlSnapshot(pool: Pool, snapshot: TvlSnapshotInput): Promise<void> {
  await pool.query(`INSERT INTO pool_tvl_snapshots (chain_id, protocol, pool_id, block_number, captured_at,
      core_amount0_raw, core_amount1_raw, sqrt_price_x96, quote_address, tvl_usd)
    VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
  [snapshot.chainId, snapshot.protocol, snapshot.poolId.toLowerCase(), snapshot.blockNumber.toString(), snapshot.capturedAtSeconds,
    snapshot.coreAmount0Raw.toString(), snapshot.coreAmount1Raw.toString(), snapshot.sqrtPriceX96.toString(),
    snapshot.quoteAddress.toLowerCase(), snapshot.tvlUsd]);
}

/** Deletes snapshots captured before `olderThanSeconds` (unix seconds); returns the number deleted. */
export async function pruneTvlSnapshots(pool: Pool, olderThanSeconds: number): Promise<number> {
  const result = await pool.query('DELETE FROM pool_tvl_snapshots WHERE captured_at < to_timestamp($1)', [olderThanSeconds]);
  return result.rowCount ?? 0;
}

/**
 * Percent change of TVL vs the snapshot nearest to `asOf − 24h` (within ±2h). Null when there is no
 * such snapshot, it was priced through a different quote asset than the current TVL, or either
 * value is unusable — never 0.
 */
export async function readTvlChange(pool: Pool, key: { chainId: number; protocol: string; poolId: string },
  quoteAddress: string, currentTvlUsd: string | null, asOf: number): Promise<string | null> {
  if (currentTvlUsd === null) return null;
  const mark = asOf - TVL_CHANGE_WINDOW_SECONDS;
  const found = await pool.query(`SELECT tvl_usd, quote_address FROM pool_tvl_snapshots
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
      AND captured_at BETWEEN to_timestamp($4) AND to_timestamp($5)
    ORDER BY abs(extract(epoch FROM captured_at) - $6) ASC LIMIT 1`,
  [key.chainId, key.protocol, key.poolId.toLowerCase(), mark - TVL_CHANGE_TOLERANCE_SECONDS,
    mark + TVL_CHANGE_TOLERANCE_SECONDS, mark]);
  const row = found.rows[0] as { tvl_usd: string; quote_address: string } | undefined;
  if (!row || row.quote_address !== quoteAddress.toLowerCase()) return null;
  return percentChange(currentTvlUsd, row.tvl_usd);
}
