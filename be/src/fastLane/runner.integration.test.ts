import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { and, eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, fastLaneState, launches, trades, venues } from '../db/schema.js';
import { readLaneBlock } from './store.js';
import { curveBuyEvent } from '../launchpads/pons/v2/abi.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import type { FastLog } from './decode.js';
import { applyLiveRows } from '../envioSync/incrementalSync.js';
import { decodeLiveLog } from './decode.js';
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
const watchedPoolId = `0x${'7e'.repeat(32)}`;
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
  await db.insert(venues).values({
    id: `fast-lane-v4-${token}`, chainId, tokenAddress: token, kind: 'v4_pool', ref: watchedPoolId, sourceId: source, sourceLogId: null,
    effectiveFromBlock: 100n, official: false,
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
  await pool.query('DELETE FROM fast_lane_venue_coverage WHERE chain_id = $1', [chainId]);
});
afterAll(async () => {
  await listener.query('UNLISTEN launchpad_events');
  await listener.end();
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  await pool.query('DELETE FROM fast_lane_venue_coverage WHERE chain_id = $1', [chainId]);
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
  it('writes a watched trade with the real trader and block time, records it, does not move the saved block and announces trade.created', async () => {
    const fake = fakeSource();
    const log = buyLog();
    await (await lane(fake)).handleLogs([log]);
    await settle();
    const rows = await tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: log.transactionHash, logIndex: 2, side: 'buy', sourceEvent: 'CurveBuy', timestamp: 1_700_000_000, traderAddress: trader });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(1);
    expect(await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId))).toHaveLength(0); // only the sweep moves the saved block
    expect(notifications).toContainEqual(expect.objectContaining({ type: 'trade.created', chainId, tokenAddress: token, blockTimestamp: 1_700_000_000 }));
  });

  it('drops the launch\'s curve pricing checkpoint when a trade lands below it, and keeps it when the trade is newer', async () => {
    const fake = fakeSource();
    const instance = await lane(fake);
    const seed = () => pool.query(`INSERT INTO launch_curve_reserves (chain_id, token_address, quote_reserve_raw, token_reserve_raw, last_block_number, last_log_index, updated_at)
      VALUES ($1,$2,'1','1',5000,5,now()) ON CONFLICT (chain_id, token_address) DO UPDATE SET last_block_number = 5000, last_log_index = 5`, [chainId, token]);
    const present = async () => (await pool.query('SELECT 1 FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows.length === 1;
    try {
      await seed();
      await instance.handleLogs([buyLog({ blockNumber: 5001n, logIndex: 1 })]); // newer than the checkpoint
      await settle();
      fake.header = { number: 5001n, hash: blockHash, timestamp: 1_700_000_001 };
      expect(await present()).toBe(true);
      await instance.handleLogs([buyLog({ blockNumber: 4999n, logIndex: 9 })]); // older: reserves after block 5000 are now wrong
      await settle();
      expect(await present()).toBe(false);
    } finally {
      await pool.query('DELETE FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    }
  });

  it('takes the sender from the block read when it carries one: no getTransaction call', async () => {
    const fake = fakeSource();
    const log = buyLog();
    fake.header = { number: 5000n, hash: blockHash, timestamp: 1_700_000_000, senders: new Map([[log.transactionHash.toLowerCase(), '0x9999999999999999999999999999999999999999']]) };
    await (await lane(fake)).handleLogs([log]);
    await settle();
    expect(fake.calls.getTransactionSender).toBe(0);
    expect((await tradeRows())[0]).toMatchObject({ txHash: log.transactionHash, traderAddress: '0x9999999999999999999999999999999999999999' });
  });

  it('can be stopped and started again (the auto mode does it), subscribing each time and keeping its timers in step', async () => {
    const fake = fakeSource();
    let subscribed = 0; let unsubscribed = 0;
    fake.subscribeLogs = () => { subscribed += 1; return () => { unsubscribed += 1; }; };
    let headReads = 0;
    const readHead = fake.getBlockNumber;
    fake.getBlockNumber = async () => { headReads += 1; return readHead(); };
    const instance = createFastLane({ source: fake, db, pool }, { chainId, lookupRetryDelayMs: 1, sweepEveryMs: 20, watchRefreshEveryMs: 20 });
    await instance.start();
    await instance.stop();
    const readsWhileStopped = headReads;
    await settle();
    expect(headReads).toBe(readsWhileStopped); // no timer runs while it is stopped
    await instance.start();
    await settle();
    expect(subscribed).toBe(2);
    expect(unsubscribed).toBe(1);
    expect(headReads).toBeGreaterThan(readsWhileStopped); // the sweep timer runs again after the restart
    await instance.stop();
    expect(unsubscribed).toBe(2);
  });

  it('ignores a log from an address that is not a known venue without any RPC call', async () => {
    const fake = fakeSource();
    const instance = await lane(fake);
    await instance.handleLogs([buyLog({}, unwatchedCurve)]);
    expect(await tradeRows()).toHaveLength(0);
    expect(fake.calls).toEqual({ getBlock: 0, getTransactionSender: 0 });
    expect(instance.stats()).toMatchObject({ received: 1, watched: 0 });
  });

  it('drops a V4 swap for a watched pool id emitted by a contract other than the PoolManager, without any RPC call', async () => {
    const fake = fakeSource();
    const instance = await lane(fake);
    nextTx += 1;
    const topics = encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: watchedPoolId as `0x${string}`, sender: trader } }) as string[];
    const data = encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [-300n, 600n, 79228162514264337593543950336n, 9n, 4, 3000]);
    const spoof: FastLog = { address: '0x9999999999999999999999999999999999999999', topics, data, blockNumber: 5000n, blockHash,
      transactionHash: `0x${nextTx.toString(16).padStart(64, '0')}`, logIndex: 3 };
    await instance.handleLogs([spoof]);
    expect(await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, spoof.transactionHash)))).toHaveLength(0);
    expect(fake.calls).toEqual({ getBlock: 0, getTransactionSender: 0 });
    expect(instance.stats()).toMatchObject({ received: 1, watched: 0, applied: 0 });
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
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n, coverageBlock: 5000n });
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

  it('anchors its first sweep at the Envio confirmed fence instead of starting at the current head', async () => {
    const fake = fakeSource();
    fake.head = 5100n;
    const getLogs = vi.spyOn(fake, 'getLogs');
    const instance = await lane(fake, { sweepChunkBlocks: 2_000n });
    await instance.sweepOnce();
    expect(getLogs.mock.calls[0]).toEqual([2n, 2001n]); // the watched source confirms block 1
    expect(await readLaneBlock(db, chainId)).toBe(5098n);
    expect((await pool.query('SELECT coverage_block FROM fast_lane_state WHERE chain_id = $1', [chainId])).rows[0]?.coverage_block).toBe('5098');
  });

  it('lets live websocket logs pass between blocks in a historical sweep', async () => {
    const fake = fakeSource();
    fake.head = 60n;
    const historical = [2n, 3n, 4n].map((blockNumber) => buyLog({ blockNumber }));
    fake.logs = historical;
    let signalFirstBlock!: () => void;
    const firstBlockStarted = new Promise<void>((resolve) => { signalFirstBlock = resolve; });
    fake.getBlock = async (blockNumber) => {
      fake.calls.getBlock += 1;
      if (blockNumber <= 4n) {
        signalFirstBlock();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return { ...fake.header!, number: blockNumber };
    };
    const instance = await lane(fake, { sweepChunkBlocks: 100n, sweepLagBlocks: 2n });
    let sweepDone = false;
    const sweepPromise = instance.sweepOnce().then(() => { sweepDone = true; });
    await firstBlockStarted;
    const live = buyLog({ blockNumber: 57n });
    await instance.handleLogs([live]);
    expect(sweepDone).toBe(false);
    expect((await tradeRows()).some((row) => row.txHash === live.transactionHash)).toBe(true);
    await sweepPromise;
  });

  it('prefetches historical block headers concurrently so coverage sweeps can catch up', async () => {
    const fake = fakeSource();
    fake.head = 60n;
    fake.logs = [2n, 3n, 4n].map((blockNumber) => buyLog({ blockNumber }));
    let active = 0;
    let peak = 0;
    fake.getBlock = async (blockNumber) => {
      fake.calls.getBlock += 1;
      if (blockNumber <= 4n) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
      }
      return { ...fake.header!, number: blockNumber };
    };
    const instance = await lane(fake, { sweepChunkBlocks: 100n, sweepLagBlocks: 2n });
    await instance.sweepOnce();
    expect(peak).toBeGreaterThan(1);
  });

  it('keeps prefetched headers inside the cache window to avoid serial refetches', async () => {
    const fake = fakeSource();
    fake.head = 1_000n;
    fake.logs = Array.from({ length: 520 }, (_, index) => buyLog({ blockNumber: BigInt(index + 2) }));
    fake.getBlock = async (blockNumber) => {
      fake.calls.getBlock += 1;
      return { ...fake.header!, number: blockNumber };
    };
    const instance = await lane(fake, { sweepChunkBlocks: 2_000n, sweepLagBlocks: 2n });
    await instance.sweepOnce();
    expect(fake.calls.getBlock).toBe(520);
  });

  it('records the Envio bridge for each watched venue and bridges a newly added venue through the saved lane block', async () => {
    const fake = fakeSource();
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const instance = await lane(fake);
    const first = await pool.query('SELECT envio_bridge_block FROM fast_lane_venue_coverage WHERE chain_id = $1 AND venue_id = $2',
      [chainId, `fast-lane-curve-${token}`]);
    expect(first.rows[0]?.envio_bridge_block).toBe('5000');

    const lateRef = '0x7e000000000000000000000000000000000000d5';
    await db.insert(venues).values({
      id: `fast-lane-late-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: lateRef, sourceId: source, sourceLogId: null,
      effectiveFromBlock: 1200n, official: true,
    }).onConflictDoNothing();
    await instance.reloadWatchSet();
    const late = await pool.query('SELECT envio_bridge_block FROM fast_lane_venue_coverage WHERE chain_id = $1 AND venue_id = $2',
      [chainId, `fast-lane-late-${token}`]);
    expect(late.rows[0]?.envio_bridge_block).toBe('5000'); // Envio must fill the interval before this venue joined the watch set
    await db.delete(venues).where(eq(venues.id, `fast-lane-late-${token}`));
  });

  it('leaves the trusted watermark unchanged when a gap is too large to scan', async () => {
    const fake = fakeSource();
    fake.head = 90_000n;
    await db.insert(fastLaneState).values({ chainId, lastBlock: 1_000n, coverageBlock: 1_000n });
    const getLogs = vi.spyOn(fake, 'getLogs');
    const instance = await lane(fake, { maxGapBlocks: 20_000n });
    await instance.sweepOnce();
    expect(getLogs).not.toHaveBeenCalled();
    const state = (await pool.query('SELECT last_block, coverage_block FROM fast_lane_state WHERE chain_id = $1', [chainId])).rows[0];
    expect(state?.last_block).toBe('89998'); // the resume cursor skips this unrecoverable range
    expect(state?.coverage_block).toBe('1000'); // the trusted watermark never crosses it
    expect((await pool.query('SELECT envio_bridge_block FROM fast_lane_venue_coverage WHERE chain_id = $1 AND venue_id = $2',
      [chainId, `fast-lane-curve-${token}`])).rows[0]?.envio_bridge_block).toBe('89998');
  });

  it('counts a failed getLogs and retries the same range on the next sweep', async () => {
    const fake = fakeSource();
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const getLogs = vi.spyOn(fake, 'getLogs').mockRejectedValueOnce(new Error('rate limited'));
    const instance = await lane(fake);
    await instance.sweepOnce();
    expect(instance.stats().errors).toBe(1);
    expect(await readLaneBlock(db, chainId)).toBe(5000n); // a failed range must not certify blocks the lane did not inspect
    await instance.sweepOnce();
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs.mock.calls[1]![0]).toBe(5001n);
  });

  it('does not advance trusted coverage when a watched sweep log cannot be hydrated', async () => {
    const fake = fakeSource();
    fake.header = null;
    fake.head = 5100n;
    fake.logs = [buyLog({ blockNumber: 5001n })];
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n, coverageBlock: 5000n });
    const instance = await lane(fake);
    await instance.sweepOnce();
    const state = (await pool.query('SELECT last_block, coverage_block FROM fast_lane_state WHERE chain_id = $1', [chainId])).rows[0];
    expect(state).toMatchObject({ last_block: '5000', coverage_block: '5000' });
    expect(await tradeRows()).toHaveLength(0);
  });

  it('applies a replacement log after a reorg and skips a late copy of the old-hash log', async () => {
    const fake = fakeSource();
    const oldLog = buyLog();
    const instance = await lane(fake);
    await instance.handleLogs([oldLog]);
    await instance.handleLogs([{ ...oldLog, removed: true }]);
    const newHash = `0x${'c8'.repeat(32)}`;
    fake.header = { number: 5000n, hash: newHash, timestamp: 1_700_000_005 };
    const replacement = buyLog({ blockHash: newHash });
    await instance.handleLogs([replacement]);
    expect((await tradeRows()).map((r) => r.txHash)).toEqual([replacement.transactionHash]);
    const skippedBefore = instance.stats().skipped;
    await instance.handleLogs([buyLog({ blockHash })]); // late copy of the old block
    expect(await tradeRows()).toHaveLength(1);
    expect(instance.stats().skipped).toBe(skippedBefore + 1);
  });

  it('re-reads a cached header whose hash differs before calling it a reorg race', async () => {
    const fake = fakeSource();
    const instance = await lane(fake);
    await instance.handleLogs([buyLog()]); // caches the header
    const newHash = `0x${'d9'.repeat(32)}`;
    fake.header = { number: 5000n, hash: newHash, timestamp: 1_700_000_007 };
    await instance.handleLogs([buyLog({ blockHash: newHash })]);
    expect(await tradeRows()).toHaveLength(2);
  });

  it('a sweep range that contains a log the WebSocket already delivered adds no row and no announcement', async () => {
    const fake = fakeSource();
    const log = buyLog();
    fake.logs = [log];
    await db.insert(fastLaneState).values({ chainId, lastBlock: 4990n });
    const instance = await lane(fake);
    await instance.handleLogs([log]);
    await instance.sweepOnce();
    await settle();
    expect(await tradeRows()).toHaveLength(1);
    expect(fake.calls.getTransactionSender).toBe(1);
    expect(notifications.filter((n) => n.type === 'trade.created')).toHaveLength(1);
  });

  it('a trade Envio already wrote stays one row and the lane announces nothing', async () => {
    const fake = fakeSource();
    const log = buyLog();
    await applyLiveRows(db, chainId, [decodeLiveLog(log, { chainId, timestamp: fake.header!.timestamp, txFrom: trader })!]);
    await settle();
    notifications.length = 0;
    await (await lane(fake)).handleLogs([log]);
    await settle();
    expect(await tradeRows()).toHaveLength(1);
    expect(notifications.filter((n) => n.type === 'trade.created')).toHaveLength(0);
  });

  it('records when the WebSocket last delivered logs, never from a sweep, and measures silence from start() until the first batch', async () => {
    const fake = fakeSource();
    let clock = 1_000_000;
    let deliver: ((logs: FastLog[]) => void) | null = null;
    fake.subscribeLogs = (onLogs) => { deliver = onLogs; return () => {}; };
    const log = buyLog({ blockNumber: 5010n });
    fake.header = { number: 5010n, hash: blockHash, timestamp: 1_700_000_050 };
    fake.logs = [log];
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const instance = createFastLane({ source: fake, db, pool }, { chainId, lookupRetryDelayMs: 1, now: () => clock, sweepEveryMs: 3_600_000 });
    await instance.start();
    expect(instance.stats().lastSocketLogAt).toBeNull();
    clock += 30_000;
    expect(instance.socketSilentForSeconds()).toBe(30);
    await instance.sweepOnce(); // applies the log through the sweep
    expect(await tradeRows()).toHaveLength(1);
    expect(instance.stats().lastSocketLogAt).toBeNull();
    clock += 5_000;
    deliver!([buyLog({ blockNumber: 5011n })]);
    expect(instance.stats().lastSocketLogAt).toBe(clock);
    clock += 7_000;
    expect(instance.socketSilentForSeconds()).toBe(7);
    await instance.stop();
  });

  it('a sweep tick while the previous sweep is still running is skipped, not queued behind it', async () => {
    const fake = fakeSource();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let headCalls = 0;
    fake.getBlockNumber = async () => { headCalls += 1; await blocked; return fake.head; };
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5098n });
    const instance = createFastLane({ source: fake, db, pool }, { chainId, lookupRetryDelayMs: 1, sweepEveryMs: 20 });
    await instance.start();
    await new Promise((resolve) => setTimeout(resolve, 150)); // several ticks while the first sweep waits on the node
    expect(headCalls).toBe(1);
    expect(instance.stats().sweepsSkipped).toBeGreaterThanOrEqual(2);
    release();
    await instance.stop();
    expect(instance.stats().errors).toBe(0);
  });
});
