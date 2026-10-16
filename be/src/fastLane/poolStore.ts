import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { launches, poolCatalog, poolTrades, sources } from '../db/schema.js';
import type { LiveEntry } from '../envioSync/incrementalSync.js';
import type { V2PoolEntry } from './decode.js';
import { notifyChanged, type ChangeNotification } from '../envioSync/notifyChanges.js';

export interface LivePoolOutcome { accepted: boolean; inserted: boolean }

/** Announce chain lifecycle changes only for launches from the watched factory. */
export async function publishLiveLaunchStateChanges(db: Database, chainId: number,
  entries: readonly { factoryAddress: string; tokenAddress: string }[]): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction(async (tx) => {
    const changes: ChangeNotification[] = [];
    for (const entry of entries) {
      const [launch] = await tx.select({ tokenAddress: launches.tokenAddress }).from(launches)
        .innerJoin(sources, eq(sources.id, launches.sourceId))
        .where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, entry.tokenAddress),
          sql`lower(${sources.factoryAddress}) = ${entry.factoryAddress.toLowerCase()}`));
      if (launch) changes.push({ kind: 'launch.changed', chainId, tokenAddress: launch.tokenAddress, via: 'fast' });
    }
    await notifyChanged(tx, changes);
  });
}

/** A liquidity or reserve event has no trade row, but current TVL, balance and depth must be reread. */
export async function publishLivePoolStateChanges(db: Database, chainId: number,
  entries: readonly { protocol: string; poolId: string; timestamp: number }[]): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction(async (tx) => {
    const changes: ChangeNotification[] = [];
    for (const entry of entries) {
      const [catalog] = await tx.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, chainId),
        eq(poolCatalog.protocol, entry.protocol), eq(poolCatalog.poolId, entry.poolId)));
      if (catalog) changes.push({ kind: 'pool.changed', chainId, poolId: entry.poolId,
        poolTokens: [catalog.currency0, catalog.currency1], blockTimestamp: entry.timestamp, via: 'fast' });
    }
    await notifyChanged(tx, changes);
  });
}

/** Persist a watched pool's swap from the WebSocket before Envio's pool sync reaches it. */
export async function applyLivePoolEntries(db: Database, chainId: number, entries: readonly (LiveEntry | V2PoolEntry)[]): Promise<LivePoolOutcome[]> {
  return db.transaction(async (tx) => {
    const changes: ChangeNotification[] = [];
    const outcomes: LivePoolOutcome[] = [];
    for (const entry of entries) {
      if (entry.stream !== 'v1-swap' && entry.stream !== 'v4-swap' && entry.stream !== 'v2-pool-swap') {
        outcomes.push({ accepted: false, inserted: false });
        continue;
      }
      const protocol = entry.stream === 'v1-swap' ? 'uniswap_v3' : entry.stream === 'v2-pool-swap' ? 'uniswap_v2' : 'uniswap_v4';
      const raw = entry.raw;
      const poolId = String(protocol === 'uniswap_v3' ? raw.poolAddress : protocol === 'uniswap_v2' ? raw.pairAddress : raw.poolId).toLowerCase();
      const [catalog] = await tx.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, chainId),
        eq(poolCatalog.protocol, protocol), eq(poolCatalog.poolId, poolId)));
      if (!catalog) {
        outcomes.push({ accepted: false, inserted: false });
        continue;
      }
      const amount0 = protocol === 'uniswap_v2' ? BigInt(String(raw.amount0In)) - BigInt(String(raw.amount0Out)) : BigInt(String(raw.amount0));
      const amount1 = protocol === 'uniswap_v2' ? BigInt(String(raw.amount1In)) - BigInt(String(raw.amount1Out)) : BigInt(String(raw.amount1));
      const sqrtPriceX96 = BigInt(String(raw.sqrtPriceX96));
      if (amount0 === 0n || amount1 === 0n) {
        outcomes.push({ accepted: true, inserted: false });
        continue;
      }
      if (amount0 * amount1 >= 0n || sqrtPriceX96 <= 0n) throw new Error(`Invalid pool swap at ${String(raw.txHash)}:${String(raw.logIndex)}`);
      const inserted = await tx.insert(poolTrades).values({
        chainId, protocol, poolId, blockNumber: BigInt(String(raw.blockNumber)), blockHash: String(raw.blockHash).toLowerCase(),
        txHash: String(raw.txHash).toLowerCase(), logIndex: Number(raw.logIndex), timestamp: Number(raw.timestamp),
        amount0Raw: amount0.toString(), amount1Raw: amount1.toString(), sqrtPriceX96: sqrtPriceX96.toString(),
        traderAddress: String(raw.txFrom).toLowerCase(), senderAddress: String(raw.sender ?? raw.txFrom).toLowerCase(),
        fee: protocol === 'uniswap_v4' ? Number(raw.fee) : catalog.fee,
      }).onConflictDoNothing().returning({ txHash: poolTrades.txHash });
      outcomes.push({ accepted: true, inserted: inserted.length > 0 });
      if (inserted.length > 0) changes.push({ kind: 'pool.changed', chainId, poolId,
        poolTokens: [catalog.currency0, catalog.currency1], blockTimestamp: Number(raw.timestamp), via: 'fast' });
    }
    await notifyChanged(tx, changes);
    return outcomes;
  });
}
