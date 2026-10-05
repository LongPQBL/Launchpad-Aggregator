import type { Pool } from 'pg';
import type { StatsFields } from './store.js';

export interface LaunchKeyRef { chainId: number; tokenAddress: string }

export async function writeLaunchStats(pool: Pool, chainId: number, tokenAddress: string, stats: StatsFields, computedAt: Date): Promise<void> {
  // Skips a launch that was removed (for example by reorg repair) after it was read for recomputation.
  await pool.query(`INSERT INTO launch_stats (chain_id, token_address, stats, computed_at)
    SELECT chain_id, token_address, $3, $4 FROM launches WHERE chain_id = $1 AND token_address = $2
    ON CONFLICT (chain_id, token_address) DO UPDATE SET stats = EXCLUDED.stats, computed_at = EXCLUDED.computed_at`,
  [chainId, tokenAddress.toLowerCase(), JSON.stringify(stats), computedAt]);
}

// Keyed by `${chainId}:${tokenAddress}`. A launch with no row yet is absent, not zero: callers render it as unavailable.
export async function readLaunchStats(pool: Pool, keys: readonly LaunchKeyRef[]): Promise<Map<string, StatsFields>> {
  const found = new Map<string, StatsFields>();
  if (keys.length === 0) return found;
  const result = await pool.query(`SELECT s.chain_id, s.token_address, s.stats FROM launch_stats s
    JOIN unnest($1::int[], $2::text[]) AS k(chain_id, token_address) ON k.chain_id = s.chain_id AND k.token_address = s.token_address`,
  [keys.map((key) => key.chainId), keys.map((key) => key.tokenAddress.toLowerCase())]);
  for (const row of result.rows) found.set(`${row.chain_id}:${row.token_address}`, row.stats as StatsFields);
  return found;
}
