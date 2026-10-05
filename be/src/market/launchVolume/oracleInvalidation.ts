import { sql, type SQL } from 'drizzle-orm';
import { invalidateLaunchVolume, type LaunchKey, type SqlExecutor } from './store.js';

const VOLUME_WINDOW_SECONDS = 86_400;

export interface PriceChange {
  chainId: number;
  quoteAssetAddress: string;
  feedAddress: string;
  fromBlock: bigint;
  toBlock: bigint;
}

interface KeyRow { chain_id: number; token_address: string }

function readRows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

function toKeys(rows: KeyRow[]): LaunchKey[] {
  return rows.map((row) => ({ chainId: row.chain_id, tokenAddress: row.token_address }));
}

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

// A price change can only move a trade's valuation if the trade is still inside the live 24-hour
// window. Bounding by that window, and by the timestamps of the rounds that changed, keeps the set
// small. Over-invalidating is safe because each recomputation is exact; missing a launch is not.
export async function invalidateForPriceChange(tx: SqlExecutor, change: PriceChange): Promise<number> {
  const windowStart = Math.floor(Date.now() / 1000) - VOLUME_WINDOW_SECONDS;
  const boundsResult = await tx.execute(sql`
    SELECT min(updated_at)::bigint AS min_updated, max(updated_at)::bigint AS max_updated
    FROM quote_usd_price_rounds
    WHERE chain_id = ${change.chainId} AND feed_address = ${change.feedAddress}
      AND block_number BETWEEN ${change.fromBlock.toString()}::bigint AND ${change.toBlock.toString()}::bigint`);
  const bounds: { min_updated: string | null; max_updated: string | null } | undefined = readRows<{ min_updated: string | null; max_updated: string | null }>(boundsResult)[0];
  const minUpdated = bounds?.min_updated == null ? null : Number(bounds.min_updated);
  const maxUpdated = bounds?.max_updated == null ? null : Number(bounds.max_updated);

  const affectedResult = await tx.execute(sql`
    SELECT DISTINCT l.chain_id, l.token_address
    FROM launches l
    JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
    JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
    WHERE l.chain_id = ${change.chainId} AND l.quote_asset_address = ${change.quoteAssetAddress.toLowerCase()}
      AND t.block_number >= ${change.fromBlock.toString()}::bigint
      AND t.timestamp >= ${windowStart}
      AND (${minUpdated}::bigint IS NULL OR t.timestamp >= ${minUpdated})
      AND (${maxUpdated}::bigint IS NULL OR t.timestamp <= ${maxUpdated === null ? 0 : maxUpdated + VOLUME_WINDOW_SECONDS})`);
  const keys = toKeys(readRows<KeyRow>(affectedResult));
  await invalidateLaunchVolume(tx, keys, new Date());
  return keys.length;
}

// Mirrors the per-launch coverage rule in api/store.ts (launchCoverageSql): a launch depends on its
// own source, the lifecycle source for V2, and each official venue's curve, V4 pool, or V3 trades source.
export async function invalidateForCoverageChange(tx: SqlExecutor, sourceIds: readonly string[]): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const ids = textArray(sourceIds);
  const affectedResult = await tx.execute(sql`
    SELECT DISTINCT l.chain_id, l.token_address
    FROM launches l
    WHERE l.source_id = ANY(${ids})
      OR (l.protocol_version = 'v2' AND 'pons-v2-lifecycle' = ANY(${ids}))
      OR EXISTS (
        SELECT 1 FROM venues v
        WHERE v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
          AND ((v.kind = 'curve' AND 'pons-v2-curve' = ANY(${ids}))
            OR (v.kind = 'v4_pool' AND ('pons-v2-v4:' || v.ref) = ANY(${ids}))
            OR (v.kind = 'v3_pool' AND (l.source_id || '-trades') = ANY(${ids}))))`);
  const keys = toKeys(readRows<KeyRow>(affectedResult));
  await invalidateLaunchVolume(tx, keys, new Date());
  return keys.length;
}
