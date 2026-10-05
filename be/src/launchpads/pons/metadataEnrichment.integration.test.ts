import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { TimeoutError } from 'viem';
import { createDatabase } from '../../db/client.js';
import { launches, metadataEnrichmentBudget, sources } from '../../db/schema.js';
import { enrichMetadataOnce } from './metadataEnrichment.js';

vi.mock('../../envioSync/incrementalSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../envioSync/incrementalSync.js')>();
  return { ...actual, repriceNullPricedTrades: vi.fn(async () => 0) };
});
const { repriceNullPricedTrades } = await import('../../envioSync/incrementalSync.js');

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const address = `0x${'d'.repeat(40)}`;
const secondAddress = `0x${'c'.repeat(40)}`;
const now = new Date('2026-10-04T12:00:00.000Z');
// repriceNullPricedTrades is mocked above — enrichMetadataOnce never does real Envio I/O in this
// file, so a stub pool is enough to thread through the new parameter.
const envioPoolStub = {} as Pool;

beforeAll(async () => {
  await db.insert(sources).values({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: address,
    startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' }).onConflictDoNothing();
});
beforeEach(async () => {
  vi.mocked(repriceNullPricedTrades).mockClear();
  await db.update(metadataEnrichmentBudget).set({ lastStartedAt: null }).where(eq(metadataEnrichmentBudget.id, 1));
  await db.insert(launches).values({
    chainId: 4663, tokenAddress: address, sourceId: 'pons-v2', sourceLogId: null,
    name: 'Old Launch', symbol: 'OLD', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2',
    factoryAddress: address, deployerAddress: address, launchBlock: 1_000_000n,
    launchTxHash: `0x${'d'.repeat(64)}`, launchLogIndex: 1, quoteAssetAddress: address,
    quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
    socialsReadState: 'done', timestampReadState: 'done', coreMetadataReadState: 'done',
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
  const firstPass = enrichMetadataOnce(db, envioPoolStub, firstClient, now, 1);
  await enteredRead;
  let secondCalls = 0;
  const secondPass = await enrichMetadataOnce(db, envioPoolStub, {
    readContract: async () => { secondCalls++; return 'unexpected'; },
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  }, new Date(now.getTime() + 60_001), 1);
  expect(secondPass.claimed).toBe(0);
  expect(secondCalls).toBe(0);
  release();
  await firstPass;
});
afterAll(async () => { await pool.end(); });

it('resolves a near-realtime-synced V1 launch\'s core metadata, retrying only the field that failed transiently', async () => {
  const v1Address = `0x${'a'.repeat(40)}`;
  const v1Factory = `0x${'b'.repeat(40)}`;
  await db.insert(launches).values({
    chainId: 4663, tokenAddress: v1Address, sourceId: 'pons-v1-legacy', sourceLogId: null,
    name: null, symbol: null, tokenDecimals: null, platform: 'pons', protocolVersion: 'v1',
    factoryAddress: v1Factory, deployerAddress: v1Address, launchBlock: 2_000_000n,
    launchTxHash: `0x${'a'.repeat(64)}`, launchLogIndex: 1, quoteAssetAddress: `0x${'0'.repeat(40)}`,
    quoteAssetSymbol: 'WETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
    logoReadState: 'done', descriptionReadState: 'done', socialsReadState: 'done', timestampReadState: 'done',
  });
  let graduationFails = true;
  const calls: string[] = [];
  const rpcClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === 'name') return 'V1 Token';
      if (functionName === 'symbol') return 'V1T';
      if (functionName === 'decimals') return 9;
      if (functionName === 'liquidityPool') return v1Address;
      if (functionName === 'graduationStatus') {
        if (graduationFails) throw new TimeoutError({ body: {}, url: 'https://rpc.example/secret' });
        return [0n, 0n, true];
      }
      throw new Error(`unexpected ${functionName}`);
    },
    getBlock: async () => { throw new Error('timestamp already done'); },
  };
  try {
    const first = await enrichMetadataOnce(db, envioPoolStub, rpcClient, now, 1);
    expect(first.pending).toBe(1);
    expect(first.transportFailures).toBe(1);
    let [row] = await db.select().from(launches).where(eq(launches.tokenAddress, v1Address));
    // name/symbol/decimals (one independent RPC group) are saved even though graduation — a
    // separate, independent call — failed transiently; the next claim's own launch is unaffected.
    expect(row.name).toBe('V1 Token');
    expect(row.symbol).toBe('V1T');
    expect(row.tokenDecimals).toBe(9);
    expect(row.lifecycleStatus).toBe('trading');
    expect(row.coreMetadataReadState).toBe('pending');
    expect(row.coreMetadataRetryAt).not.toBeNull();

    graduationFails = false;
    calls.length = 0;
    const second = await enrichMetadataOnce(db, envioPoolStub, rpcClient, new Date(now.getTime() + 60_001), 1);
    expect(second.completed).toBe(1);
    expect(calls).toEqual(expect.arrayContaining(['graduationStatus']));
    [row] = await db.select().from(launches).where(eq(launches.tokenAddress, v1Address));
    expect(row.lifecycleStatus).toBe('graduated');
    expect(row.coreMetadataReadState).toBe('done');
    expect(row.coreMetadataRetryAt).toBeNull();
    // Decimals just resolved (name/symbol/decimals group) — repriceNullPricedTrades must run for
    // this launch so any trade recorded while decimals were unknown gets its real price filled in,
    // not left null forever (final review, Critical 2).
    expect(repriceNullPricedTrades).toHaveBeenCalledWith(
      envioPoolStub, db, expect.objectContaining({ tokenAddress: v1Address, tokenDecimals: 9 }),
    );
  } finally {
    await db.delete(launches).where(eq(launches.tokenAddress, v1Address));
  }
});

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
  const first = await enrichMetadataOnce(db, envioPoolStub, rpcClient, now, 1);
  expect(first).toEqual({ claimed: 1, completed: 0, pending: 1, transportFailures: 1, unknownFailures: 0 });
  expect(calls).toEqual(['logo', 'description']);
  let [row] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  expect(row.logoUri).toBe('ipfs://recovered-logo');
  expect(row.logoReadState).toBe('done');
  expect(row.descriptionReadState).toBe('pending');
  expect(row.metadataRetryAt?.toISOString()).toBe('2026-10-04T12:01:00.000Z');

  descriptionFails = false;
  calls.length = 0;
  const second = await enrichMetadataOnce(db, envioPoolStub, rpcClient, new Date(now.getTime() + 60_001), 1);
  expect(second).toEqual({ claimed: 1, completed: 1, pending: 0, transportFailures: 0, unknownFailures: 0 });
  expect(calls).toEqual(['description']);
  [row] = await db.select().from(launches).where(eq(launches.tokenAddress, address));
  expect(row.description).toBe('Recovered description');
  expect(row.descriptionReadState).toBe('done');
  expect(row.metadataRetryAt).toBeNull();
});
