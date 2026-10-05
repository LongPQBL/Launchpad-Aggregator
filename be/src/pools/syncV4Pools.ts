import type { Pool } from 'pg';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Database, DbOrTx } from '../db/client.js';
import { poolCatalog, poolPendingSwaps, poolSyncCursors, poolTrades } from '../db/schema.js';
import { readRawPage, readRawRowById, readRawWindowKeys } from '../envioSync/incrementalPage.js';
import type { CursorPosition } from '../envioSync/incrementalCursor.js';
import { upsertVerifiedPool } from './catalog.js';
import { verifyV4Initialize } from './identity.js';

export type PoolStream = 'initialize' | 'swap';
export type PoolLane = 'tail' | 'history';
export const DEFAULT_POOL_TABLES = { initialize: 'envio."RawV4Initialize"', swap: 'envio."RawV4Swap"' };

export interface PoolSyncInput {
  chainId: number;
  stream: PoolStream;
  lane: PoolLane;
  fence: bigint;
  limit: number;
  tables?: Partial<Record<PoolStream, string>>;
}
export interface PoolSyncPageResult { applied: number; pending: number; cursor: CursorPosition; processedWatermark: bigint }
export interface PoolRepairInput { chainId: number; fence: bigint; depth: bigint; tables?: Partial<Record<PoolStream, string>> }
export interface PoolRepairReport { removedPools: number; removedSwaps: number }

/** Only a fully drained historical scan can certify finalized pool rows. */
export async function updatePoolCoverage(appDb: Database, chainId: number, fence: bigint): Promise<void> {
  const safeFence = fence > 500n ? fence - 500n : 0n;
  const cursors = await appDb.select().from(poolSyncCursors).where(and(eq(poolSyncCursors.chainId, chainId),
    eq(poolSyncCursors.lane, 'history')));
  const complete = (['initialize', 'swap'] as const).every((stream) =>
    cursors.some((row) => row.stream === stream && (row.processedWatermark ?? -1n) >= safeFence));
  const pending = await appDb.select({ rawId: poolPendingSwaps.rawId }).from(poolPendingSwaps)
    .where(and(eq(poolPendingSwaps.chainId, chainId), lte(poolPendingSwaps.blockNumber, safeFence))).limit(1);
  if (complete && pending.length === 0) {
    await appDb.update(poolCatalog).set({ coverageStatus: 'caught_up' }).where(and(
      eq(poolCatalog.chainId, chainId), lte(poolCatalog.blockNumber, safeFence), eq(poolCatalog.coverageStatus, 'backfilling')));
  } else {
    await appDb.update(poolCatalog).set({ coverageStatus: 'backfilling' }).where(and(
      eq(poolCatalog.chainId, chainId), eq(poolCatalog.coverageStatus, 'caught_up')));
  }
}

function position(row: typeof poolSyncCursors.$inferSelect): CursorPosition {
  return { blockNumber: row.blockNumber, logIndex: row.logIndex, rawId: row.rawId };
}
async function claimCursor(db: DbOrTx, input: Pick<PoolSyncInput, 'chainId' | 'stream' | 'lane'>) {
  await db.insert(poolSyncCursors).values(input).onConflictDoNothing();
  const [row] = await db.select().from(poolSyncCursors).where(and(eq(poolSyncCursors.chainId, input.chainId),
    eq(poolSyncCursors.stream, input.stream), eq(poolSyncCursors.lane, input.lane)));
  if (!row) throw new Error('Pool cursor could not be claimed');
  return row;
}

function rawPosition(raw: Record<string, unknown>) {
  return { blockNumber: BigInt(String(raw.blockNumber)), blockHash: String(raw.blockHash),
    txHash: String(raw.txHash), logIndex: Number(raw.logIndex) };
}

async function applyInitialize(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<void> {
  const pool = verifyV4Initialize({
    chainId, poolId: String(raw.poolId), currency0: String(raw.currency0), currency1: String(raw.currency1),
    fee: Number(raw.fee), tickSpacing: Number(raw.tickSpacing), hooks: String(raw.hooks), ...rawPosition(raw),
  });
  if (!pool) throw new Error(`Invalid V4 Initialize Pool ID at raw row ${String(raw.id)}`);
  await upsertVerifiedPool(tx, pool);
}

async function applySwap(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<boolean> {
  const poolId = String(raw.poolId).toLowerCase();
  const [pool] = await tx.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, chainId),
    eq(poolCatalog.protocol, 'uniswap_v4'), eq(poolCatalog.poolId, poolId)));
  if (!pool) {
    await tx.insert(poolPendingSwaps).values({ chainId, rawId: String(raw.id), poolId,
      blockNumber: BigInt(String(raw.blockNumber)) }).onConflictDoNothing();
    return false;
  }
  const amount0 = BigInt(String(raw.amount0));
  const amount1 = BigInt(String(raw.amount1));
  const sqrtPriceX96 = BigInt(String(raw.sqrtPriceX96));
  if (amount0 === 0n || amount1 === 0n || amount0 * amount1 >= 0n || sqrtPriceX96 <= 0n) {
    throw new Error(`Invalid V4 Swap amounts at raw row ${String(raw.id)}`);
  }
  const event = rawPosition(raw);
  await tx.insert(poolTrades).values({
    chainId, protocol: 'uniswap_v4', poolId, blockNumber: event.blockNumber,
    blockHash: event.blockHash.toLowerCase(), txHash: event.txHash.toLowerCase(), logIndex: event.logIndex,
    timestamp: Number(raw.timestamp), amount0Raw: amount0.toString(), amount1Raw: amount1.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(), traderAddress: String(raw.txFrom).toLowerCase(),
    senderAddress: String(raw.sender).toLowerCase(), fee: Number(raw.fee),
  }).onConflictDoNothing();
  await tx.delete(poolPendingSwaps).where(and(eq(poolPendingSwaps.chainId, chainId), eq(poolPendingSwaps.rawId, String(raw.id))));
  return true;
}

async function retryPending(envioPool: Pool, tx: DbOrTx, chainId: number, swapTable: string, limit: number): Promise<number> {
  const pending = await tx.select().from(poolPendingSwaps).where(eq(poolPendingSwaps.chainId, chainId)).limit(limit);
  let resolved = 0;
  for (const row of pending) {
    const [pool] = await tx.select({ poolId: poolCatalog.poolId }).from(poolCatalog).where(and(
      eq(poolCatalog.chainId, chainId), eq(poolCatalog.protocol, 'uniswap_v4'), eq(poolCatalog.poolId, row.poolId)));
    if (!pool) continue;
    const raw = await readRawRowById(envioPool, swapTable, row.rawId);
    if (raw) await applySwap(tx, chainId, raw);
    else await tx.delete(poolPendingSwaps).where(and(eq(poolPendingSwaps.chainId, chainId), eq(poolPendingSwaps.rawId, row.rawId)));
    resolved += 1;
  }
  return resolved;
}

/** Apply one bounded raw page and its cursor in the same app-DB transaction. */
export async function syncV4PoolPage(envioPool: Pool, appDb: Database, input: PoolSyncInput): Promise<PoolSyncPageResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) throw new Error('Invalid pool page limit');
  const tables = { ...DEFAULT_POOL_TABLES, ...input.tables };
  const cursor = await claimCursor(appDb, input);
  const after = cursor.processedWatermark === null && input.lane === 'tail'
    ? { blockNumber: input.fence > 500n ? input.fence - 500n : 0n, logIndex: -1, rawId: '' }
    : position(cursor);
  const page = await readRawPage(envioPool, { table: tables[input.stream], chainId: input.chainId,
    after, fence: input.fence, limit: input.limit });
  let applied = 0;
  let pending = 0;
  const nextPosition = page.lastPosition ?? after;
  const processedWatermark = page.rows.length === input.limit && page.lastPosition
    ? (page.lastPosition.blockNumber > 0n ? page.lastPosition.blockNumber - 1n : 0n) : input.fence;
  await appDb.transaction(async (tx) => {
    for (const raw of page.rows) {
      if (input.stream === 'initialize') { await applyInitialize(tx, input.chainId, raw); applied += 1; }
      else if (await applySwap(tx, input.chainId, raw)) applied += 1;
      else pending += 1;
    }
    if (input.stream === 'initialize') applied += await retryPending(envioPool, tx, input.chainId, tables.swap, input.limit);
    await tx.update(poolSyncCursors).set({ ...nextPosition, processedWatermark }).where(and(
      eq(poolSyncCursors.chainId, input.chainId), eq(poolSyncCursors.stream, input.stream), eq(poolSyncCursors.lane, input.lane)));
  });
  return { applied, pending, cursor: nextPosition, processedWatermark };
}

/** Compare only the provisional window, deleting stale pool rows/swaps and rewinding affected cursors. */
export async function repairPoolWindow(envioPool: Pool, appDb: Database, input: PoolRepairInput): Promise<PoolRepairReport> {
  const tables = { ...DEFAULT_POOL_TABLES, ...input.tables };
  const start = input.fence > input.depth ? input.fence - input.depth : 0n;
  const [initializeKeys, swapKeys] = await Promise.all([
    readRawWindowKeys(envioPool, tables.initialize, input.chainId, start, input.fence),
    readRawWindowKeys(envioPool, tables.swap, input.chainId, start, input.fence),
  ]);
  const canonical = (keys: { txHash: string; logIndex: number; blockHash: string }[]) =>
    new Map(keys.map((key) => [`${key.txHash}:${key.logIndex}`, key.blockHash]));
  const initMap = canonical(initializeKeys);
  const swapMap = canonical(swapKeys);
  let removedPools = 0;
  let removedSwaps = 0;
  await appDb.transaction(async (tx) => {
    const existingSwaps = await tx.select().from(poolTrades).where(and(eq(poolTrades.chainId, input.chainId),
      gte(poolTrades.blockNumber, start)));
    for (const row of existingSwaps) {
      if (swapMap.get(`${row.txHash}:${row.logIndex}`) === row.blockHash) continue;
      await tx.delete(poolTrades).where(and(eq(poolTrades.chainId, row.chainId), eq(poolTrades.txHash, row.txHash),
        eq(poolTrades.logIndex, row.logIndex)));
      removedSwaps += 1;
    }
    const existingPools = await tx.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, input.chainId),
      gte(poolCatalog.blockNumber, start)));
    for (const row of existingPools) {
      if (initMap.get(`${row.txHash}:${row.logIndex}`) === row.blockHash) continue;
      await tx.delete(poolCatalog).where(and(eq(poolCatalog.chainId, row.chainId),
        eq(poolCatalog.protocol, row.protocol), eq(poolCatalog.poolId, row.poolId)));
      removedPools += 1;
    }
    for (const stream of ['initialize', 'swap'] as const) {
      for (const lane of ['tail', 'history'] as const) {
        const cursor = await claimCursor(tx, { chainId: input.chainId, stream, lane });
        const stale = stream === 'initialize' ? removedPools > 0 : removedSwaps > 0 || removedPools > 0;
        if ((stale || (cursor.processedWatermark ?? 0n) > input.fence) && cursor.blockNumber > start) {
          await tx.update(poolSyncCursors).set({ blockNumber: start, logIndex: -1, rawId: '', processedWatermark: start })
            .where(and(eq(poolSyncCursors.chainId, input.chainId), eq(poolSyncCursors.stream, stream), eq(poolSyncCursors.lane, lane)));
        }
      }
    }
  });
  return { removedPools, removedSwaps };
}
