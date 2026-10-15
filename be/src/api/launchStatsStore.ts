import type { Pool } from 'pg';
import type { StatsFields } from './store.js';
import { NULL_TVL } from '../market/tvlStats.js';

export interface LaunchKeyRef { chainId: number; tokenAddress: string }
export interface LaunchStatsSnapshot { stats: StatsFields; computedAt: Date }

export async function writeLaunchStats(pool: Pool, chainId: number, tokenAddress: string, stats: StatsFields, computedAt: Date): Promise<void> {
  // Skips a launch that was removed (for example by reorg repair) after it was read for recomputation.
  await pool.query(`INSERT INTO launch_stats (chain_id, token_address, stats, computed_at)
    SELECT chain_id, token_address, $3, $4 FROM launches WHERE chain_id = $1 AND token_address = $2
    ON CONFLICT (chain_id, token_address) DO UPDATE SET stats = EXCLUDED.stats, computed_at = EXCLUDED.computed_at`,
  [chainId, tokenAddress.toLowerCase(), JSON.stringify(stats), computedAt]);
}

// Price, FDV, market cap, TVL and the 1h/1d changes move with the market, so a stored figure older than this is unavailable
// (null), not the last computed value. The 52-week range changes slowly and keeps its last value. The worker refreshes every 5 minutes.
export const MARKET_STATS_MAX_AGE_MS = Number(process.env.MARKET_STATS_MAX_AGE_MS ?? 3_600_000);

export function expireMarketStats(stats: StatsFields, computedAt: Date | null, now: Date = new Date()): StatsFields {
  if (computedAt && now.getTime() - computedAt.getTime() <= MARKET_STATS_MAX_AGE_MS) return stats;
  return { ...stats, ...NULL_TVL, fdvUsd: null, marketCapUsd: null, priceUsd: null, change1h: null, change1d: null };
}

// Keyed by `${chainId}:${tokenAddress}`. A launch with no row yet is absent, not zero: callers render it as unavailable.
export async function readLaunchStats(pool: Pool, keys: readonly LaunchKeyRef[]): Promise<Map<string, StatsFields>> {
  const found = new Map<string, StatsFields>();
  if (keys.length === 0) return found;
  const result = await pool.query(`SELECT s.chain_id, s.token_address, s.stats, s.computed_at FROM launch_stats s
    JOIN unnest($1::int[], $2::text[]) AS k(chain_id, token_address) ON k.chain_id = s.chain_id AND k.token_address = s.token_address`,
  [keys.map((key) => key.chainId), keys.map((key) => key.tokenAddress.toLowerCase())]);
  for (const row of result.rows) found.set(`${row.chain_id}:${row.token_address}`, expireMarketStats(row.stats as StatsFields, row.computed_at ?? null));
  return found;
}

export async function readLaunchStatsSnapshots(pool: Pool, keys: readonly LaunchKeyRef[]): Promise<Map<string, LaunchStatsSnapshot>> {
  const found = new Map<string, LaunchStatsSnapshot>();
  if (keys.length === 0) return found;
  const result = await pool.query(`SELECT s.chain_id, s.token_address, s.stats, s.computed_at FROM launch_stats s
    JOIN unnest($1::int[], $2::text[]) AS k(chain_id, token_address) ON k.chain_id = s.chain_id AND k.token_address = s.token_address`,
  [keys.map((key) => key.chainId), keys.map((key) => key.tokenAddress.toLowerCase())]);
  for (const row of result.rows) {
    const computedAt = new Date(row.computed_at);
    found.set(`${row.chain_id}:${row.token_address}`, {
      stats: expireMarketStats(row.stats as StatsFields, computedAt), computedAt,
    });
  }
  return found;
}
