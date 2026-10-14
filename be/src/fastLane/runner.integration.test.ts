import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { and, eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, fastLaneState, launches, trades, venues } from '../db/schema.js';
import { curveBuyEvent } from '../launchpads/pons/v2/abi.js';
import type { FastLog } from './decode.js';
import { createFastLane, type BlockHeader, type FastLaneOptions, type LaneChainSource } from './runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const chainId = 4663; // applyRow hydrates against the Pons sources, which are chain 4663
const source = 'fast-lane-runner-test';
const token = '0x7e00000000000000000000000000000000000001';
const curve = '0x7e000000000000000000000000000000000000c1';
const unwatchedCurve = '0x7e000000000000000000000000000000000000c2';
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const trader = '0x1111111111111111111111111111111111111111';
const blockHash = `0x${'b7'.repeat(32)}`;
let nextTx = 0;

function buyLog(overrides: Partial<FastLog> = {}, address = curve): FastLog {
  nextTx += 1;
  const topics = encodeEventTopics({ abi: [curveBuyEvent], eventName: 'CurveBuy', args: { buyer: trader, recipient: trader } }) as string[];
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [2000000000000000000n, 1000000000000000000n, 0n, 0n]);
  return { address, topics, data, blockNumber: 5000n, blockHash, transactionHash: `0x${nextTx.toString(16).padStart(64, '0')}`, logIndex: 2, ...overrides };
}

interface Fake extends LaneChainSource { calls: { getBlock: number; getTransactionSender: number }; logs: FastLog[]; head: bigint; header: BlockHeader | null; sender: string | null }
function fakeSource(): Fake {
  const fake: Fake = {
    calls: { getBlock: 0, getTransactionSender: 0 }, logs: [], head: 5100n, header: { number: 5000n, hash: blockHash, timestamp: 1_700_000_000 }, sender: trader,
    async getBlock() { fake.calls.getBlock += 1; return fake.header; },
    async getTransactionSender() { fake.calls.getTransactionSender += 1; return fake.sender; },
    async getLogs(from, to) { return fake.logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to); },
    async getBlockNumber() { return fake.head; },
    subscribeLogs() { return () => {}; },
  };
  return fake;
}

const listener = new Client({ connectionString: databaseUrl });
const notifications: Record<string, unknown>[] = [];
beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await db.insert(launches).values({
    chainId, tokenAddress: token, sourceId: source, sourceLogId: null, name: 'Lane', symbol: 'LANE', tokenDecimals: 18, platform: 'pons',
    protocolVersion: 'v2', factoryAddress: curve, deployerAddress: token, launchBlock: 100n, launchBlockHash: `0x${'aa'.repeat(32)}`,
    launchTxHash: `0x${'7e'.repeat(32)}`, launchLogIndex: 1, quoteAssetAddress: weth, quoteAssetSymbol: 'WETH', quoteAssetDecimals: 18,
    lifecycleStatus: 'trading', coreMetadataReadState: 'done',
  }).onConflictDoNothing();
  await db.insert(venues).values({
    id: `fast-lane-curve-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: curve, sourceId: source, sourceLogId: null,
    effectiveFromBlock: 100n, official: true,
  }).onConflictDoNothing();
  await listener.connect();
  listener.on('notification', (message) => { if (message.payload) notifications.push(JSON.parse(message.payload)); });
  await listener.query('LISTEN launchpad_events');
});
beforeEach(async () => {
  notifications.length = 0;
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
});
afterAll(async () => {
  await listener.query('UNLISTEN launchpad_events');
  await listener.end();
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

async function lane(fake: Fake, extra: Partial<Omit<FastLaneOptions, 'chainId'>> = {}) {
  const instance = createFastLane({ source: fake, db, pool }, { chainId, lookupRetryDelayMs: 1, ...extra });
  await instance.reloadWatchSet();
  return instance;
}
const tradeRows = () => db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('fast lane', () => {
  it('writes a watched trade with the real trader and block time, records it, advances its block and announces trade.created', async () => {
    const fake = fakeSource();
    const log = buyLog();
    await (await lane(fake)).handleLogs([log]);
    await settle();
    const rows = await tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: log.transactionHash, logIndex: 2, side: 'buy', sourceEvent: 'CurveBuy', timestamp: 1_700_000_000, traderAddress: trader });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(1);
    expect((await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId)))[0]?.lastBlock).toBe(5000n);
    expect(notifications).toContainEqual(expect.objectContaining({ type: 'trade.created', chainId, tokenAddress: token, blockTimestamp: 1_700_000_000 }));
  });

  it('ignores a log from an address that is not a known venue without any RPC call', async () => {
    const fake = fakeSource();
    const instance = await lane(fake);
    await instance.handleLogs([buyLog({}, unwatchedCurve)]);
    expect(await tradeRows()).toHaveLength(0);
    expect(fake.calls).toEqual({ getBlock: 0, getTransactionSender: 0 });
    expect(instance.stats()).toMatchObject({ received: 1, watched: 0 });
  });

  it('skips a log whose block hash is not the one the node reports now (a reorg race)', async () => {
    const fake = fakeSource();
    fake.header = { number: 5000n, hash: `0x${'99'.repeat(32)}`, timestamp: 1_700_000_000 };
    const instance = await lane(fake);
    await instance.handleLogs([buyLog()]);
    expect(await tradeRows()).toHaveLength(0);
    expect(instance.stats().skipped).toBe(1);
  });

  it('writes nothing when the header or the sender cannot be had, and never invents a trader', async () => {
    const noHeader = fakeSource();
    noHeader.header = null;
    const a = await lane(noHeader);
    await a.handleLogs([buyLog()]);
    expect(noHeader.calls.getBlock).toBe(3); // retried, then gave up
    const noSender = fakeSource();
    noSender.sender = null;
    const b = await lane(noSender);
    await b.handleLogs([buyLog()]);
    expect(await tradeRows()).toHaveLength(0);
    expect(a.stats().skipped + b.stats().skipped).toBe(2);
  });

  it('delivers the same event twice (WebSocket, then sweep) as one row and one announcement', async () => {
    const fake = fakeSource();
    const log = buyLog();
    fake.logs = [log];
    const instance = await lane(fake);
    await instance.handleLogs([log]);
    await instance.handleLogs([log]);
    await instance.sweepOnce(); // the lane's saved block is 5000 and the fake head is 5100: it scans 5001..5098, where the fake has no log
    await settle();
    expect(await tradeRows()).toHaveLength(1);
    expect(notifications.filter((n) => n.type === 'trade.created')).toHaveLength(1);
    expect(fake.calls.getTransactionSender).toBe(1); // the repeat was recognised before any lookup
  });

  it('deletes the row and announces launch.changed when the node reports the log removed', async () => {
    const fake = fakeSource();
    const log = buyLog();
    const instance = await lane(fake);
    await instance.handleLogs([log]);
    expect(await tradeRows()).toHaveLength(1);
    notifications.length = 0;
    await instance.handleLogs([{ ...log, removed: true }]);
    await settle();
    expect(await tradeRows()).toHaveLength(0);
    expect(notifications).toContainEqual(expect.objectContaining({ type: 'launch.changed', chainId, tokenAddress: token }));
    expect(instance.stats().removed).toBe(1);
  });

  it('fills a gap with getLogs from its saved block, in chunks, and resumes from there after a restart', async () => {
    const fake = fakeSource();
    const log = buyLog({ blockNumber: 5010n });
    fake.header = { number: 5010n, hash: blockHash, timestamp: 1_700_000_050 };
    fake.logs = [log];
    fake.head = 5100n;
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const getLogs = vi.spyOn(fake, 'getLogs');
    const instance = await lane(fake, { sweepChunkBlocks: 50n, sweepLagBlocks: 2n });
    await instance.sweepOnce();
    expect(getLogs.mock.calls.map(([from, to]) => [from, to])).toEqual([[5001n, 5050n], [5051n, 5098n]]);
    expect(await tradeRows()).toHaveLength(1);
    expect((await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId)))[0]?.lastBlock).toBe(5098n);
    const restarted = await lane(fake, { sweepChunkBlocks: 50n });
    getLogs.mockClear();
    await restarted.sweepOnce();
    expect(getLogs).not.toHaveBeenCalled(); // nothing new since 5098
  });

  it('skips a gap larger than the limit instead of scanning it', async () => {
    const fake = fakeSource();
    fake.head = 90_000n;
    await db.insert(fastLaneState).values({ chainId, lastBlock: 1_000n });
    const getLogs = vi.spyOn(fake, 'getLogs');
    const instance = await lane(fake, { maxGapBlocks: 20_000n });
    await instance.sweepOnce();
    expect(getLogs).not.toHaveBeenCalled();
    expect((await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId)))[0]?.lastBlock).toBe(89_998n);
  });

  it('counts a failed getLogs and retries the same range on the next sweep', async () => {
    const fake = fakeSource();
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const getLogs = vi.spyOn(fake, 'getLogs').mockRejectedValueOnce(new Error('rate limited'));
    const instance = await lane(fake);
    await instance.sweepOnce();
    expect(instance.stats().errors).toBe(1);
    await instance.sweepOnce();
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs.mock.calls[1]![0]).toBe(5001n);
  });
});
