import type { Pool } from 'pg';
import { robinhood } from '../chains/robinhood.js';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { calculateTvlUsd } from '../market/tvlValue.js';
import { readUsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { readLensSnapshot } from './lens.js';
import { assetDecimals } from './stats.js';
import { insertTvlSnapshot, pruneTvlSnapshots } from './tvlSnapshots.js';

export const MIN_RETENTION_HOURS = 26;
const MIN_INTERVAL_SECONDS = 60;
// Spacing is the interval plus the cycle's own duration, so it must stay well under the 4h-wide (+-2h)
// comparison window or a read can find no snapshot.
const MAX_INTERVAL_SECONDS = 10_800;

export interface SnapshotConfig { intervalSeconds: number; retentionHours: number }

export function parseSnapshotConfig(env: Record<string, string | undefined>): SnapshotConfig {
  const intervalSeconds = Number(env.POOL_TVL_SNAPSHOT_INTERVAL_SECONDS ?? 3600);
  const retentionHours = Number(env.POOL_TVL_SNAPSHOT_RETENTION_HOURS ?? 168);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`POOL_TVL_SNAPSHOT_INTERVAL_SECONDS must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} so a snapshot always falls inside the 24h comparison window`);
  }
  if (!Number.isFinite(retentionHours) || retentionHours < MIN_RETENTION_HOURS) {
    throw new Error(`POOL_TVL_SNAPSHOT_RETENTION_HOURS must be >= ${MIN_RETENTION_HOURS} so pruning can never delete the snapshot the 24h comparison needs`);
  }
  return { intervalSeconds, retentionHours };
}

interface CatalogRow { chain_id: number; pool_id: string; currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }

async function captureOne(pool: Pool, client: UsdPriceClient, row: CatalogRow, nowSeconds: number): Promise<boolean> {
  const quoteAddress = (await resolveVerifiedFeed(pool, row.chain_id, row.currency0)) ? row.currency0
    : (await resolveVerifiedFeed(pool, row.chain_id, row.currency1)) ? row.currency1 : null;
  if (quoteAddress === null) return false;
  const quoteIsCurrency0 = quoteAddress === row.currency0;
  const [decimals0, decimals1] = await Promise.all([assetDecimals(client, row.currency0), assetDecimals(client, row.currency1)]);
  if (decimals0 === null || decimals1 === null) return false;
  const quoteUsd = await readUsdPrice(pool, client, row.chain_id, quoteAddress, () => nowSeconds * 1000);
  if (!quoteUsd) return false;
  const lens = await readLensSnapshot(client, row);
  if (!lens) return false;
  const tvlUsd = calculateTvlUsd({
    tokenRaw: quoteIsCurrency0 ? lens.coreAmount1 : lens.coreAmount0,
    quoteRaw: quoteIsCurrency0 ? lens.coreAmount0 : lens.coreAmount1,
    blockNumber: lens.blockNumber, basis: 'pool_principal', sqrtPriceX96: lens.sqrtPriceX96,
    tokenIsCurrency0: !quoteIsCurrency0,
  }, quoteIsCurrency0 ? decimals0 : decimals1, quoteIsCurrency0 ? decimals1 : decimals0, quoteUsd.priceUsd);
  if (tvlUsd === null) return false;
  await insertTvlSnapshot(pool, {
    chainId: row.chain_id, protocol: 'uniswap_v4', poolId: row.pool_id, blockNumber: lens.blockNumber,
    capturedAtSeconds: nowSeconds, coreAmount0Raw: lens.coreAmount0, coreAmount1Raw: lens.coreAmount1,
    sqrtPriceX96: lens.sqrtPriceX96, quoteAddress, tvlUsd,
  });
  return true;
}

/** One pass over every verified V4 pool on the chain this worker's RPC client serves (Robinhood). A pool that cannot be read or priced is skipped, never stored as a guess. */
export async function captureTvlSnapshots(pool: Pool, client: UsdPriceClient, nowSeconds: number,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): Promise<{ captured: number; skipped: number }> {
  const pools = (await pool.query(`SELECT chain_id, pool_id, currency0, currency1, fee, tick_spacing, hooks
    FROM pool_catalog WHERE protocol='uniswap_v4' AND verified=true AND chain_id=$1`, [robinhood.id])).rows as CatalogRow[];
  let captured = 0;
  let skipped = 0;
  for (const row of pools) {
    try {
      if (await captureOne(pool, client, row, nowSeconds)) captured += 1; else skipped += 1;
    } catch (error) {
      skipped += 1;
      log(`TVL snapshot failed for pool ${row.pool_id}`, error);
    }
  }
  return { captured, skipped };
}

/** Capture, then prune — pruning runs even if the capture pass throws, so an outage cannot grow the table. */
export async function runSnapshotCycle(pool: Pool, client: UsdPriceClient, config: SnapshotConfig,
  nowSeconds: number): Promise<{ captured: number; skipped: number; pruned: number }> {
  const outcome = await captureTvlSnapshots(pool, client, nowSeconds).then(
    (result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
  const pruned = await pruneTvlSnapshots(pool, nowSeconds - config.retentionHours * 3600);
  if (!outcome.ok) throw outcome.error;
  return { ...outcome.result, pruned };
}
