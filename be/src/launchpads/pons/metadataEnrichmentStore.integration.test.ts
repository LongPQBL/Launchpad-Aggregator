import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../../db/client.js';
import { launches, metadataEnrichmentBudget, sources } from '../../db/schema.js';
import type { MetadataReadResults } from './extendedMetadata.js';
import { claimDueMetadataLaunches, finishMetadataLaunch, nextMetadataRetryAt } from './metadataEnrichmentStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const now = new Date('2026-10-04T00:00:00.000Z');
const inserted: string[] = [];
const claimedLeaseIds: string[] = [];
const token = (n: number) => `0x${'e'.repeat(36)}${n.toString(16).padStart(4, '0')}`;

async function claimDue(...args: Parameters<typeof claimDueMetadataLaunches>) {
  const claims = await claimDueMetadataLaunches(...args);
  claimedLeaseIds.push(...claims.map((row) => row.leaseId));
  return claims;
}

async function addLaunch(n: number, overrides: Partial<typeof launches.$inferInsert> = {}) {
  const address = token(n);
  inserted.push(address);
  await db.insert(launches).values({
    chainId: 4663, tokenAddress: address, sourceId: 'pons-v2', sourceLogId: null,
    name: `Token ${n}`, symbol: `T${n}`, tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2',
    factoryAddress: token(1000), deployerAddress: token(1001), launchBlock: BigInt(n),
    launchTxHash: `0x${n.toString(16).padStart(64, '0')}`, launchLogIndex: n,
    quoteAssetAddress: token(1002), quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18,
    lifecycleStatus: 'trading', coreMetadataReadState: 'done', ...overrides,
  });
  return address;
}

const doneResults: MetadataReadResults = {
  logo: { state: 'done', value: null },
  description: { state: 'done', value: null },
  socials: { state: 'done', value: { websiteUrl: null, twitterUrl: null } },
  timestamp: { state: 'done', value: 1_700_000_000 },
};

beforeAll(async () => {
  await db.insert(sources).values({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: token(1000),
    startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' }).onConflictDoNothing();
});
beforeEach(async () => {
  await db.update(metadataEnrichmentBudget).set({ lastStartedAt: null }).where(eq(metadataEnrichmentBudget.id, 1));
});
afterEach(async () => {
  for (const address of inserted.splice(0)) await db.delete(launches).where(eq(launches.tokenAddress, address));
  for (const leaseId of claimedLeaseIds.splice(0)) {
    await db.update(launches).set({ metadataLeaseId: null, metadataLeaseUntil: null })
      .where(eq(launches.metadataLeaseId, leaseId));
  }
  await db.update(metadataEnrichmentBudget).set({ lastStartedAt: null }).where(eq(metadataEnrichmentBudget.id, 1));
});
afterAll(async () => { await pool.end(); });

it('claims half newest and half oldest due launches, then enforces the shared minute budget', async () => {
  // Keep both fixture ends outside the test database's pre-existing launch block range.
  for (let n = 1; n <= 12; n++) await addLaunch(n, { launchBlock: BigInt(n <= 6 ? n : 1_000_000_000_000 + n) });
  const claims = await claimDue(db, now, 10, 120_000);
  expect(claims.map((row) => row.tokenAddress).sort()).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12].map(token).sort());
  expect(await claimDue(db, new Date(now.getTime() + 30_000), 10, 120_000)).toEqual([]);
});

it('allows only one concurrent claimant and permits reclaim after lease expiry', async () => {
  const address = await addLaunch(20);
  const [first, second] = await Promise.all([
    claimDue(db, now, 10, 1_000),
    claimDue(db, now, 10, 1_000),
  ]);
  expect([...first, ...second].filter((row) => row.tokenAddress === address)).toHaveLength(1);
  expect(first.length === 0 || second.length === 0).toBe(true);
  await db.update(metadataEnrichmentBudget).set({ lastStartedAt: null }).where(eq(metadataEnrichmentBudget.id, 1));
  expect((await claimDue(db, new Date(now.getTime() + 500), 10, 1_000))
    .filter((row) => row.tokenAddress === address)).toEqual([]);
  expect((await claimDue(db, new Date(now.getTime() + 60_001), 10, 1_000))
    .filter((row) => row.tokenAddress === address)).toHaveLength(1);
});

it('rejects a stale result after Envio replaces the launch during reorg', async () => {
  const address = await addLaunch(30);
  const claim = (await claimDue(db, now, 10, 120_000)).find((row) => row.tokenAddress === address)!;
  await db.delete(launches).where(eq(launches.tokenAddress, address));
  inserted.pop();
  await addLaunch(30, { launchTxHash: `0x${'f'.repeat(64)}` });
  expect(await finishMetadataLaunch(db, claim, doneResults, now)).toBe(false);
  const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  expect(row.logoReadState).toBe('pending');
  expect(row.launchTimestamp).toBeNull();
});

it('stores a successful empty social result as done, without scheduling another retry', async () => {
  const address = await addLaunch(40, {
    logoReadState: 'done', descriptionReadState: 'done', timestampReadState: 'done',
  });
  const claim = (await claimDue(db, now, 10, 120_000)).find((row) => row.tokenAddress === address)!;
  expect(await finishMetadataLaunch(db, claim, doneResults, now)).toBe(true);
  const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  expect(row.socialsReadState).toBe('done');
  expect(row.websiteUrl).toBeNull();
  expect(row.twitterUrl).toBeNull();
  expect(row.metadataRetryAt).toBeNull();
});

it('starts retrying after one minute, doubles once, and caps at one hour', () => {
  expect(nextMetadataRetryAt(now, 0).toISOString()).toBe('2026-10-04T00:01:00.000Z');
  expect(nextMetadataRetryAt(now, 1).toISOString()).toBe('2026-10-04T00:02:00.000Z');
  expect(nextMetadataRetryAt(now, 99).toISOString()).toBe('2026-10-04T01:00:00.000Z');
});
