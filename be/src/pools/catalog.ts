import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { poolCatalog, poolMembers } from '../db/schema.js';
import { verifyV4Initialize, type VerifiedPool } from './identity.js';

/** Insert an independently verified Initialize and its exact two-token membership. */
export async function upsertVerifiedPool(tx: DbOrTx, pool: VerifiedPool): Promise<void> {
  // A TypeScript type alone is not a trust boundary: callers can deserialize or cast a payload.
  const canonical = verifyV4Initialize(pool);
  if (!canonical || pool.protocol !== 'uniswap_v4' || pool.verified !== true) throw new Error('Invalid verified V4 pool');
  await tx.insert(poolCatalog).values({ ...canonical, coverageStatus: 'backfilling' }).onConflictDoUpdate({
    target: [poolCatalog.chainId, poolCatalog.protocol, poolCatalog.poolId],
    set: { blockNumber: canonical.blockNumber, blockHash: canonical.blockHash, txHash: canonical.txHash,
      logIndex: canonical.logIndex,
      coverageStatus: sql`CASE WHEN ${poolCatalog.blockHash} IS DISTINCT FROM ${canonical.blockHash}
        OR ${poolCatalog.blockNumber} IS DISTINCT FROM ${canonical.blockNumber}
        OR ${poolCatalog.txHash} IS DISTINCT FROM ${canonical.txHash}
        OR ${poolCatalog.logIndex} IS DISTINCT FROM ${canonical.logIndex}
        THEN 'backfilling' ELSE ${poolCatalog.coverageStatus} END` },
    setWhere: sql`${poolCatalog.blockNumber} <= ${canonical.blockNumber}`,
  });
  await tx.insert(poolMembers).values([
    { chainId: canonical.chainId, protocol: canonical.protocol, poolId: canonical.poolId, tokenAddress: canonical.currency0 },
    { chainId: canonical.chainId, protocol: canonical.protocol, poolId: canonical.poolId, tokenAddress: canonical.currency1 },
  ]).onConflictDoNothing();
}
