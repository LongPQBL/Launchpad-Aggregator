import type { Pool } from 'pg';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Database, DbOrTx } from '../db/client.js';
import { poolCatalog, poolMembers, poolPendingSwaps, poolSourceAudits, poolSyncCursors, poolTrades } from '../db/schema.js';
import { readRawPage, readRawRowById, readRawWindowKeys } from '../envioSync/incrementalPage.js';
import type { CursorPosition } from '../envioSync/incrementalCursor.js';
import { SOURCE_DEPLOYMENT_BLOCK, V2_FACTORY, V3_FACTORY, verifyV2PairCreated, verifyV3PoolCreated,
  type AdditionalPoolProtocol } from './sourceRegistry.js';

export type AdditionalPoolStream = 'v3_created' | 'v3_swap' | 'v2_created' | 'v2_swap';
export const DEFAULT_ADDITIONAL_POOL_TABLES = {
  v3_created: 'envio."RawV3PoolCreated"', v3_swap: 'envio."RawV3Swap"',
  v2_created: 'envio."RawV2PairCreated"', v2_swap: 'envio."RawV2Swap"',
  v2_sync: 'envio."RawV2Sync"',
};
type Tables = typeof DEFAULT_ADDITIONAL_POOL_TABLES;
export interface AdditionalPoolSyncInput { chainId: number; stream: AdditionalPoolStream; lane: 'tail' | 'history';
  fence: bigint; limit: number; tables?: Partial<Tables> }
export interface AdditionalPoolSyncResult { applied: number; pending: number; cursor: CursorPosition; processedWatermark: bigint }
function protocol(stream: AdditionalPoolStream): AdditionalPoolProtocol { return stream.startsWith('v3') ? 'uniswap_v3' : 'uniswap_v2'; }
function position(row: typeof poolSyncCursors.$inferSelect): CursorPosition {
  return { blockNumber: row.blockNumber, logIndex: row.logIndex, rawId: row.rawId };
}
async function claimCursor(db: DbOrTx, input: Pick<AdditionalPoolSyncInput, 'chainId' | 'stream' | 'lane'>) {
  await db.insert(poolSyncCursors).values(input).onConflictDoNothing();
  const [row] = await db.select().from(poolSyncCursors).where(and(eq(poolSyncCursors.chainId, input.chainId),
    eq(poolSyncCursors.stream, input.stream), eq(poolSyncCursors.lane, input.lane)));
  if (!row) throw new Error('Additional pool cursor unavailable');
  return row;
}
function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Negative reserve ratio');
  if (value < 2n) return value;
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (true) { const next = (x + value / x) >> 1n; if (next >= x) return x; x = next; }
}
export function v2SqrtPriceX96(reserve0: bigint, reserve1: bigint): bigint | null {
  if (reserve0 <= 0n || reserve1 <= 0n) return null;
  return integerSqrt((reserve1 << 192n) / reserve0);
}
const SAFE_TABLE = /^"?[A-Za-z_][A-Za-z0-9_]*"?\."?[A-Za-z_][A-Za-z0-9_]*"?$/;
async function v2SyncForSwap(envioPool: Pool, table: string, raw: Record<string, unknown>): Promise<bigint | null> {
  if (!SAFE_TABLE.test(table)) throw new Error('Unsafe V2 Sync table');
  const result = await envioPool.query(`SELECT "reserve0","reserve1" FROM ${table}
    WHERE "chainId"=$1 AND "pairAddress"=$2 AND "txHash"=$3 AND "logIndex" < $4
    ORDER BY "logIndex" DESC LIMIT 1`, [raw.chainId, String(raw.pairAddress).toLowerCase(), raw.txHash, raw.logIndex]);
  const sync = result.rows[0] as { reserve0: string; reserve1: string } | undefined;
  return sync ? v2SqrtPriceX96(BigInt(sync.reserve0), BigInt(sync.reserve1)) : null;
}
async function applyCreated(tx: DbOrTx, chainId: number, raw: Record<string, unknown>, source: AdditionalPoolProtocol): Promise<void> {
  const candidate = { chainId, factoryAddress: String(raw.factoryAddress), token0: String(raw.token0),
    token1: String(raw.token1), poolAddress: raw.poolAddress === undefined ? undefined : String(raw.poolAddress),
    pairAddress: raw.pairAddress === undefined ? undefined : String(raw.pairAddress),
    fee: raw.fee === undefined ? undefined : Number(raw.fee),
    tickSpacing: raw.tickSpacing === undefined ? undefined : Number(raw.tickSpacing),
    blockNumber: BigInt(String(raw.blockNumber)), blockHash: String(raw.blockHash),
    txHash: String(raw.txHash), logIndex: Number(raw.logIndex) };
  const verified = source === 'uniswap_v3' ? verifyV3PoolCreated(candidate) : verifyV2PairCreated(candidate);
  if (!verified) throw new Error(`Invalid ${source} factory event ${String(raw.id)}`);
  await tx.insert(poolCatalog).values({ ...verified, coverageStatus: 'incomplete' }).onConflictDoUpdate({
    target: [poolCatalog.chainId, poolCatalog.protocol, poolCatalog.poolId],
    set: { blockNumber: verified.blockNumber, blockHash: verified.blockHash, txHash: verified.txHash,
      logIndex: verified.logIndex, coverageStatus: 'incomplete' },
    setWhere: lte(poolCatalog.blockNumber, verified.blockNumber),
  });
  await tx.insert(poolMembers).values([verified.currency0, verified.currency1].map((tokenAddress) => ({
    chainId, protocol: source, poolId: verified.poolId, tokenAddress,
  }))).onConflictDoNothing();
}
async function queuePending(tx: DbOrTx, chainId: number, source: AdditionalPoolProtocol, poolId: string,
  raw: Record<string, unknown>): Promise<void> {
  await tx.insert(poolPendingSwaps).values({ chainId, protocol: source, rawId: String(raw.id), poolId,
    blockNumber: BigInt(String(raw.blockNumber)) }).onConflictDoNothing();
}
async function applySwap(envioPool: Pool, tx: DbOrTx, chainId: number, raw: Record<string, unknown>,
  source: AdditionalPoolProtocol, tables: Tables): Promise<boolean> {
  const poolId = String(source === 'uniswap_v3' ? raw.poolAddress : raw.pairAddress).toLowerCase();
  const [catalog] = await tx.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, chainId),
    eq(poolCatalog.protocol, source), eq(poolCatalog.poolId, poolId)));
  if (!catalog) { await queuePending(tx, chainId, source, poolId, raw); return false; }
  const amount0 = source === 'uniswap_v3' ? BigInt(String(raw.amount0))
    : BigInt(String(raw.amount0In)) - BigInt(String(raw.amount0Out));
  const amount1 = source === 'uniswap_v3' ? BigInt(String(raw.amount1))
    : BigInt(String(raw.amount1In)) - BigInt(String(raw.amount1Out));
  if (amount0 === 0n || amount1 === 0n || amount0 * amount1 >= 0n) {
    // Flash swaps and malformed rows cannot be valued with the two-sided trade model.
    await queuePending(tx, chainId, source, poolId, raw); return false;
  }
  const sqrtPriceX96 = source === 'uniswap_v3' ? BigInt(String(raw.sqrtPriceX96))
    : await v2SyncForSwap(envioPool, tables.v2_sync, raw);
  if (sqrtPriceX96 === null || sqrtPriceX96 <= 0n) {
    await queuePending(tx, chainId, source, poolId, raw); return false;
  }
  await tx.insert(poolTrades).values({ chainId, protocol: source, poolId,
    blockNumber: BigInt(String(raw.blockNumber)), blockHash: String(raw.blockHash).toLowerCase(),
    txHash: String(raw.txHash).toLowerCase(), logIndex: Number(raw.logIndex), timestamp: Number(raw.timestamp),
    amount0Raw: amount0.toString(), amount1Raw: amount1.toString(), sqrtPriceX96: sqrtPriceX96.toString(),
    traderAddress: String(raw.txFrom).toLowerCase(), senderAddress: String(raw.sender).toLowerCase(), fee: catalog.fee,
  }).onConflictDoNothing();
  await tx.delete(poolPendingSwaps).where(and(eq(poolPendingSwaps.chainId, chainId), eq(poolPendingSwaps.rawId, String(raw.id))));
  return true;
}
async function retryPending(envioPool: Pool, tx: DbOrTx, chainId: number, source: AdditionalPoolProtocol,
  tables: Tables, limit: number): Promise<number> {
  const pending = await tx.select().from(poolPendingSwaps).where(and(eq(poolPendingSwaps.chainId, chainId),
    eq(poolPendingSwaps.protocol, source))).limit(limit);
  let resolved = 0;
  for (const row of pending) {
    const raw = await readRawRowById(envioPool, tables[source === 'uniswap_v3' ? 'v3_swap' : 'v2_swap'], row.rawId);
    if (!raw) { await tx.delete(poolPendingSwaps).where(and(eq(poolPendingSwaps.chainId, chainId),
      eq(poolPendingSwaps.rawId, row.rawId))); continue; }
    if (await applySwap(envioPool, tx, chainId, raw, source, tables)) resolved += 1;
  }
  return resolved;
}

/** Bounded keyset ingestion with transactional cursor; V3/V2 rows stay hidden until parity certification. */
export async function syncV3V2PoolPage(envioPool: Pool, appDb: Database,
  input: AdditionalPoolSyncInput): Promise<AdditionalPoolSyncResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) throw new Error('Invalid pool page limit');
  const tables = { ...DEFAULT_ADDITIONAL_POOL_TABLES, ...input.tables };
  const cursor = await claimCursor(appDb, input);
  const after = cursor.processedWatermark === null && input.lane === 'tail'
    ? { blockNumber: input.fence > 500n ? input.fence - 500n : 0n, logIndex: -1, rawId: '' }
    : position(cursor);
  const page = await readRawPage(envioPool, { table: tables[input.stream], chainId: input.chainId,
    after, fence: input.fence, limit: input.limit });
  const source = protocol(input.stream);
  let applied = 0;
  let pending = 0;
  const nextPosition = page.lastPosition ?? after;
  const processedWatermark = page.rows.length === input.limit && page.lastPosition
    ? (page.lastPosition.blockNumber > 0n ? page.lastPosition.blockNumber - 1n : 0n) : input.fence;
  await appDb.transaction(async (tx) => {
    for (const raw of page.rows) {
      if (input.stream.endsWith('created')) { await applyCreated(tx, input.chainId, raw, source); applied += 1; }
      else if (await applySwap(envioPool, tx, input.chainId, raw, source, tables)) applied += 1;
      else pending += 1;
    }
    if (input.stream.endsWith('created')) applied += await retryPending(envioPool, tx, input.chainId, source, tables, input.limit);
    await tx.update(poolSyncCursors).set({ ...nextPosition, processedWatermark }).where(and(
      eq(poolSyncCursors.chainId, input.chainId), eq(poolSyncCursors.stream, input.stream), eq(poolSyncCursors.lane, input.lane)));
  });
  return { applied, pending, cursor: nextPosition, processedWatermark };
}

export async function updateAdditionalPoolCoverage(appDb: Database, chainId: number, fence: bigint): Promise<void> {
  const safeFence = fence > 500n ? fence - 500n : 0n;
  const cursors = await appDb.select().from(poolSyncCursors).where(and(eq(poolSyncCursors.chainId, chainId),
    eq(poolSyncCursors.lane, 'history')));
  for (const source of ['uniswap_v3', 'uniswap_v2'] as const) {
    const prefix = source === 'uniswap_v3' ? 'v3' : 'v2';
    const complete = (['created', 'swap'] as const).every((suffix) => cursors.some((row) =>
      row.stream === `${prefix}_${suffix}` && (row.processedWatermark ?? -1n) >= safeFence));
    const [audit] = await appDb.select().from(poolSourceAudits).where(and(eq(poolSourceAudits.chainId, chainId),
      eq(poolSourceAudits.protocol, source)));
    const pending = await appDb.select({ rawId: poolPendingSwaps.rawId }).from(poolPendingSwaps).where(and(
      eq(poolPendingSwaps.chainId, chainId), eq(poolPendingSwaps.protocol, source),
      lte(poolPendingSwaps.blockNumber, safeFence))).limit(1);
    const status = complete && pending.length === 0 && audit?.status === 'complete'
      && (audit.auditedToBlock ?? -1n) >= safeFence ? 'caught_up' : 'incomplete';
    await appDb.update(poolCatalog).set({ coverageStatus: status }).where(and(eq(poolCatalog.chainId, chainId),
      eq(poolCatalog.protocol, source), lte(poolCatalog.blockNumber, safeFence)));
  }
}

/** Compare canonical raw keys in the provisional window before changing only this source's rows. */
export async function repairV3V2PoolWindow(envioPool: Pool, appDb: Database, input: {
  chainId: number; source: AdditionalPoolProtocol; fence: bigint; depth?: bigint; tables?: Partial<Tables>;
}): Promise<{ removedPools: number; removedSwaps: number }> {
  const tables = { ...DEFAULT_ADDITIONAL_POOL_TABLES, ...input.tables };
  const start = input.fence > (input.depth ?? 500n) ? input.fence - (input.depth ?? 500n) : 0n;
  const prefix = input.source === 'uniswap_v3' ? 'v3' : 'v2';
  const [created, swaps] = await Promise.all([
    readRawWindowKeys(envioPool, tables[`${prefix}_created`], input.chainId, start, input.fence),
    readRawWindowKeys(envioPool, tables[`${prefix}_swap`], input.chainId, start, input.fence),
  ]);
  const canonical = (rows: typeof created) => new Map(rows.map((row) => [`${row.txHash}:${row.logIndex}`, row.blockHash]));
  const creationKeys = canonical(created);
  const swapKeys = canonical(swaps);
  let removedPools = 0;
  let removedSwaps = 0;
  await appDb.transaction(async (tx) => {
    const existingSwaps = await tx.select().from(poolTrades).where(and(eq(poolTrades.chainId, input.chainId),
      eq(poolTrades.protocol, input.source), gte(poolTrades.blockNumber, start)));
    for (const row of existingSwaps) {
      if (swapKeys.get(`${row.txHash}:${row.logIndex}`) === row.blockHash) continue;
      await tx.delete(poolTrades).where(and(eq(poolTrades.chainId, row.chainId), eq(poolTrades.txHash, row.txHash),
        eq(poolTrades.logIndex, row.logIndex)));
      removedSwaps += 1;
    }
    const existingPools = await tx.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, input.chainId),
      eq(poolCatalog.protocol, input.source), gte(poolCatalog.blockNumber, start)));
    for (const row of existingPools) {
      if (creationKeys.get(`${row.txHash}:${row.logIndex}`) === row.blockHash) continue;
      await tx.delete(poolCatalog).where(and(eq(poolCatalog.chainId, row.chainId), eq(poolCatalog.protocol, row.protocol),
        eq(poolCatalog.poolId, row.poolId)));
      removedPools += 1;
    }
    for (const stream of [`${prefix}_created`, `${prefix}_swap`] as AdditionalPoolStream[]) {
      for (const lane of ['tail', 'history'] as const) {
        const cursor = await claimCursor(tx, { chainId: input.chainId, stream, lane });
        const stale = stream.endsWith('created') ? removedPools > 0 : removedPools > 0 || removedSwaps > 0;
        if ((stale || (cursor.processedWatermark ?? 0n) > input.fence)
          && cursor.blockNumber > start) await tx.update(poolSyncCursors).set({ blockNumber: start, logIndex: -1,
            rawId: '', processedWatermark: start }).where(and(eq(poolSyncCursors.chainId, input.chainId),
            eq(poolSyncCursors.stream, stream), eq(poolSyncCursors.lane, lane)));
      }
    }
  });
  return { removedPools, removedSwaps };
}

export async function ensureAdditionalPoolSourceAudit(appDb: Database, chainId: number): Promise<void> {
  for (const source of ['uniswap_v3', 'uniswap_v2'] as const) {
    await appDb.insert(poolSourceAudits).values({ chainId, protocol: source,
      factoryAddress: source === 'uniswap_v3' ? V3_FACTORY : V2_FACTORY,
      deploymentBlock: SOURCE_DEPLOYMENT_BLOCK[source], status: 'pending' }).onConflictDoNothing();
  }
}
