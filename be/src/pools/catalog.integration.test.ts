import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { encodeAbiParameters, keccak256 } from 'viem';
import { createDatabase } from '../db/client.js';
import { poolCatalog, poolMembers } from '../db/schema.js';
import { verifyV4Initialize } from './identity.js';
import { upsertVerifiedPool } from './catalog.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const chainId = 996633;
const nativeChainId = 996634;
const zero = '0x0000000000000000000000000000000000000000';
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const hook = '0x3333333333333333333333333333333333333333';
const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [a, b, 3000, 60, hook],
));
const raw = { chainId, poolId, currency0: a, currency1: b, fee: 3000, tickSpacing: 60, hooks: hook,
  blockNumber: 100n, blockHash: `0x${'ab'.repeat(32)}`, txHash: `0x${'cd'.repeat(32)}`, logIndex: 2 };

afterAll(async () => {
  await db.delete(poolCatalog).where(eq(poolCatalog.chainId, chainId));
  await db.delete(poolCatalog).where(eq(poolCatalog.chainId, nativeChainId));
  await pool.end();
});

describe('upsertVerifiedPool', () => {
  it('stores native ETH as the exact zero-address member', async () => {
    const nativePoolId = keccak256(encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [zero, a, 3000, 60, hook],
    ));
    await upsertVerifiedPool(db, verifyV4Initialize({ ...raw, chainId: nativeChainId,
      poolId: nativePoolId, currency0: zero, currency1: a })!);
    const members = await db.select().from(poolMembers).where(eq(poolMembers.chainId, nativeChainId));
    expect(members.map((member) => member.tokenAddress).sort()).toEqual([zero, a]);
  });

  it('rejects a forged verified payload with a false Pool ID', async () => {
    const forged = { ...verifyV4Initialize(raw)!, poolId: `0x${'ef'.repeat(32)}` as `0x${string}` };
    await expect(upsertVerifiedPool(db, forged)).rejects.toThrow('Invalid verified V4 pool');
    expect(await db.select().from(poolCatalog).where(and(eq(poolCatalog.chainId, chainId),
      eq(poolCatalog.poolId, forged.poolId)))).toEqual([]);
  });

  it('deduplicates Initialize, records exact membership on both sides, and updates reorg provenance', async () => {
    const verified = verifyV4Initialize(raw)!;
    await db.transaction(async (tx) => {
      await upsertVerifiedPool(tx, verified);
      await upsertVerifiedPool(tx, verified);
    });
    let rows = await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ poolId, currency0: a, currency1: b, blockHash: raw.blockHash, coverageStatus: 'backfilling' });
    const members = await db.select().from(poolMembers).where(eq(poolMembers.chainId, chainId));
    expect(members.map((member) => member.tokenAddress).sort()).toEqual([a, b]);
    expect(await db.select().from(poolMembers).where(and(eq(poolMembers.chainId, chainId), eq(poolMembers.tokenAddress,
      '0x4444444444444444444444444444444444444444')))).toEqual([]);

    await db.update(poolCatalog).set({ coverageStatus: 'caught_up' }).where(eq(poolCatalog.chainId, chainId));
    await upsertVerifiedPool(db, verified);
    expect((await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId)))[0]?.coverageStatus).toBe('caught_up');

    const replacement = verifyV4Initialize({ ...raw, blockNumber: 101n, blockHash: `0x${'ee'.repeat(32)}` })!;
    await upsertVerifiedPool(db, replacement);
    rows = await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockNumber).toBe(101n);
    expect(rows[0]?.blockHash).toBe(replacement.blockHash);
    expect(rows[0]?.coverageStatus).toBe('backfilling');
    expect(await db.select().from(poolMembers).where(eq(poolMembers.chainId, chainId))).toHaveLength(2);
  });
});
