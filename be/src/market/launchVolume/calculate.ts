import type { Pool } from 'pg';
import { formatUnits } from 'viem';
import { launchCoverageSql } from '../../coverage/launchCoverageSql.js';
import type { CompletenessReason, LaunchKey, RankCategory, VolumeScore } from './store.js';

const VOLUME_WINDOW_SECONDS = 86_400;
const USD_SCALE = 10n ** 30n;

// Arithmetic mirrors api/store.ts listLaunchesByVolume so a cached score equals the read-side value:
// fixed-point bigint sums, the same round-at-or-before-position lookup, and the same 24h price age rule.
export async function calculateLaunchVolume(pool: Pool, key: LaunchKey, windowEnd: number, headBlock: bigint | null): Promise<VolumeScore> {
  const launchResult = await pool.query(`
    SELECT l.launch_block, l.launch_tx_hash, l.launch_log_index, l.quote_asset_decimals,
      ${launchCoverageSql(3)} AS complete
    FROM launches l WHERE l.chain_id = $1 AND l.token_address = $2`,
  [key.chainId, key.tokenAddress, headBlock?.toString() ?? null]);
  const launch = launchResult.rows[0];
  if (!launch) throw new Error(`launch ${key.chainId}:${key.tokenAddress} not found`);

  const tradesResult = await pool.query(`
    SELECT l.quote_asset_decimals, t.quote_amount_raw, t.timestamp, f.feed_address,
      r.answer_raw, r.decimals AS price_decimals, r.updated_at AS price_updated_at
    FROM launches l
    JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
    JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
      AND t.timestamp >= $3 AND t.timestamp <= $4
    LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address
      AND f.verification_status = 'verified'
    LEFT JOIN LATERAL (
      SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
      WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
      ORDER BY block_number DESC, log_index DESC LIMIT 1
    ) r ON true
    WHERE l.chain_id = $1 AND l.token_address = $2`,
  [key.chainId, key.tokenAddress, windowEnd - VOLUME_WINDOW_SECONDS, windowEnd]);

  let total = 0n;
  let hasUnpriced = false;
  let earliestTimestamp: number | null = null;
  for (const row of tradesResult.rows) {
    const timestamp = Number(row.timestamp);
    if (earliestTimestamp === null || timestamp < earliestTimestamp) earliestTimestamp = timestamp;
    if (row.feed_address === null || row.answer_raw === null || row.quote_asset_decimals === null) {
      hasUnpriced = true;
      continue;
    }
    const ageSeconds = timestamp - Number(row.price_updated_at);
    if (ageSeconds < 0 || ageSeconds > VOLUME_WINDOW_SECONDS) {
      hasUnpriced = true;
      continue;
    }
    const divisor = 10n ** BigInt(row.quote_asset_decimals) * 10n ** BigInt(row.price_decimals);
    total += (BigInt(row.quote_amount_raw) * BigInt(row.answer_raw) * USD_SCALE) / divisor;
  }

  let volumeUsd: string | null;
  let rankCategory: RankCategory;
  let completenessReason: CompletenessReason;
  if (launch.complete !== true) {
    [volumeUsd, rankCategory, completenessReason] = [null, 'null', 'incomplete_coverage'];
  } else if (hasUnpriced) {
    [volumeUsd, rankCategory, completenessReason] = [null, 'null', 'unpriced_trade'];
  } else if (total === 0n) {
    [volumeUsd, rankCategory, completenessReason] = ['0', 'zero', 'complete'];
  } else {
    [volumeUsd, rankCategory, completenessReason] = [formatUnits(total, 30), 'positive', 'complete'];
  }

  return {
    volumeUsd,
    rankCategory,
    computedAt: new Date(),
    windowEnd,
    // A trade stays in [windowEnd - 86400, windowEnd], so the earliest one leaves at its timestamp + 86401.
    nextExpiryAt: earliestTimestamp === null ? null : new Date((earliestTimestamp + VOLUME_WINDOW_SECONDS + 1) * 1000),
    completenessReason,
    launchBlock: BigInt(launch.launch_block),
    launchTxHash: launch.launch_tx_hash,
    launchLogIndex: launch.launch_log_index,
  };
}
