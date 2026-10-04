import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TimeoutError } from 'viem';
import { createDatabase } from '../../db/client.js';
import { launches, metadataEnrichmentBudget, sources } from '../../db/schema.js';
import { enrichMetadataOnce } from './metadataEnrichment.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const address = `0x${'d'.repeat(40)}`;
const secondAddress = `0x${'c'.repeat(40)}`;
const now = new Date('2026-10-04T12:00:00.000Z');

beforeAll(async () => {
  await db.insert(sources).values({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: address,
    startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' }).onConflictDoNothing();
});
beforeEach(async () => {
  await db.update(metadataEnrichmentBudget).set({ lastStartedAt: null }).where(eq(metadataEnrichmentBudget.id, 1));
  await db.insert(launches).values({
    chainId: 4663, tokenAddress: address, sourceId: 'pons-v2', sourceLogId: null,
    name: 'Old Launch', symbol: 'OLD', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2',
    factoryAddress: address, deployerAddress: address, launchBlock: 1_000_000n,
    launchTxHash: `0x${'d'.repeat(64)}`, launchLogIndex: 1, quoteAssetAddress: address,
    quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
    socialsReadState: 'done', timestampReadState: 'done',
  });
});
afterEach(async () => {
  await db.delete(launches).where(eq(launches.tokenAddress, address));
  await db.delete(launches).where(eq(launches.tokenAddress, secondAddress));
  await db.update(metadataEnrichmentBudget).set({ lastStartedAt: null }).where(eq(metadataEnrichmentBudget.id, 1));
});

it('keeps only one RPC enrichment worker active across overlapping Envio processes', async () => {
  const [base] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  await db.insert(launches).values({ ...base, tokenAddress: secondAddress,
    launchBlock: 999_999n, launchTxHash: `0x${'c'.repeat(64)}` });
  let entered!: () => void;
  const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const heldRead = new Promise<void>((resolve) => { release = resolve; });
  const firstClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') { entered(); await heldRead; }
      return functionName === 'socials' ? ['', '', '', '', ''] : 'ready';
    },
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  };
  const firstPass = enrichMetadataOnce(db, firstClient, now, 1);
  await enteredRead;
  let secondCalls = 0;
  const secondPass = await enrichMetadataOnce(db, {
    readContract: async () => { secondCalls++; return 'unexpected'; },
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  }, new Date(now.getTime() + 60_001), 1);
  expect(secondPass.claimed).toBe(0);
  expect(secondCalls).toBe(0);
  release();
  await firstPass;
});
afterAll(async () => { await pool.end(); });

it('repairs a launch far outside the reorg window, then retries only the field that timed out', async () => {
  const calls: string[] = [];
  let descriptionFails = true;
  const rpcClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === 'logo') return 'ipfs://recovered-logo';
      if (functionName === 'description' && descriptionFails) throw new TimeoutError({ body: {}, url: 'https://rpc.example/secret' });
      if (functionName === 'description') return 'Recovered description';
      throw new Error(`unexpected ${functionName}`);
    },
    getBlock: async () => { throw new Error('timestamp was already done'); },
  };
  const first = await enrichMetadataOnce(db, rpcClient, now, 1);
  expect(first).toEqual({ claimed: 1, completed: 0, pending: 1, transportFailures: 1, unknownFailures: 0 });
  expect(calls).toEqual(['logo', 'description']);
  let [row] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  expect(row.logoUri).toBe('ipfs://recovered-logo');
  expect(row.logoReadState).toBe('done');
  expect(row.descriptionReadState).toBe('pending');
  expect(row.metadataRetryAt?.toISOString()).toBe('2026-10-04T12:01:00.000Z');

  descriptionFails = false;
  calls.length = 0;
  const second = await enrichMetadataOnce(db, rpcClient, new Date(now.getTime() + 60_001), 1);
  expect(second).toEqual({ claimed: 1, completed: 1, pending: 0, transportFailures: 0, unknownFailures: 0 });
  expect(calls).toEqual(['description']);
  [row] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  expect(row.description).toBe('Recovered description');
  expect(row.descriptionReadState).toBe('done');
  expect(row.metadataRetryAt).toBeNull();
});
