import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import type { IndexBatch, Launch, Trade, Venue } from '../domain/types.js';
import { logKey } from '../domain/ids.js';
import { createDatabase } from './client.js';
import { createRepository } from './repository.js';
import { createApiStore } from '../api/store.js';
import { ApiEventBus } from '../api/events.js';
import { listenForDatabaseEvents } from '../api/pgEvents.js';
import { createVenueStore } from '../indexer/venueStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Integration tests require a database ending in _test');
}

const { db, pool } = createDatabase(databaseUrl);
const repository = createRepository(db);
const token = '0x1111111111111111111111111111111111111111' as Address;
const factory = '0x2222222222222222222222222222222222222222' as Address;
const poolAddress = '0x3333333333333333333333333333333333333333' as Address;
const quote = '0x4444444444444444444444444444444444444444' as Address;
const trader = '0x7777777777777777777777777777777777777777' as Address;
const txHash = `0x${'5'.repeat(64)}` as Hash;
const blockHash = `0x${'6'.repeat(64)}` as Hash;

function batch(chainId: number, sourceId: string, tokenAmountRaw = 1_000_000_000_000_000_000n): IndexBatch {
  const launch: Launch = {
    chainId,
    tokenAddress: token,
    name: 'Example',
    symbol: 'EX',
    tokenDecimals: 18,
    platform: 'pons',
    protocolVersion: 'v1',
    sourceId,
    sourceLogId: logKey(chainId, blockHash, txHash, 0),
    factoryAddress: factory,
    deployerAddress: factory,
    launchBlock: 100n,
    launchTxHash: txHash,
    quoteAsset: { address: quote, symbol: 'WETH', decimals: 18 },
    lifecycleStatus: 'trading',
  };
  const venue: Venue = {
    id: `${chainId}:v3_pool:${poolAddress}`,
    chainId,
    tokenAddress: token,
    kind: 'v3_pool',
    ref: poolAddress,
    sourceId,
    sourceLogId: logKey(chainId, blockHash, txHash, 0),
    effectiveFromBlock: 100n,
    effectiveToBlock: null,
    official: true,
  };
  const trade: Trade = {
    chainId,
    tokenAddress: token,
    venueId: venue.id,
    blockNumber: 100n,
    blockHash,
    txHash,
    logIndex: 1,
    timestamp: 1_700_000_000,
    side: 'buy',
    tokenAmountRaw,
    quoteAmountRaw: 100_000_000_000_000_000n,
    quoteAssetAddress: quote,
    sourceEvent: 'Swap',
    activityKind: 'user_trade',
    priceNumeratorRaw: 1n,
    priceDenominatorRaw: 10n,
    traderAddress: trader,
  };
  return {
    rawLogs: [
      { chainId, sourceId, blockNumber: 100n, blockHash, txHash, logIndex: 0, address: factory, topics: [], data: '0x' },
      { chainId, sourceId, blockNumber: 100n, blockHash, txHash, logIndex: 1, address: poolAddress, topics: [], data: '0x' },
    ],
    launches: [launch],
    venues: [venue],
    trades: [trade],
    transitions: [],
  };
}

// Migration runs once in vitest.integration.globalSetup.ts, before any test file's own setup.
beforeEach(async () => {
  await pool.query('TRUNCATE TABLE trades, venues, launches, raw_logs, candles, observed_blocks, sources RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('index batch repository', () => {
  it('persists a sequential batch when saveIndexBatch is passed as a callback', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const saveIndexBatch = repository.saveIndexBatch;
    await saveIndexBatch('test-a', 100n, 100n, { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] });
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(100n);
  });

  it('leases distinct certified windows to workers and only advances a contiguous frontier', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 101n, toBlock: 101n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    const now = new Date();
    const first = await repository.claimScanJob('worker-a', now, 10_000);
    const second = await repository.claimScanJob('worker-b', now, 10_000);
    expect(first?.id).not.toBe(second?.id);
    expect(first?.fromBlock).toBe(100n);
    expect(second?.fromBlock).toBe(101n);
    const empty = { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };
    await repository.commitScanJob(second!.id, 'worker-b', second!.generation, empty);
    expect(await repository.getCertifiedFrontier('test-a')).toBe(99n);
    await repository.commitScanJob(first!.id, 'worker-a', first!.generation, empty);
    expect(await repository.getCertifiedFrontier('test-a')).toBe(101n);
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(101n);
  });

  it('persists a batch with more trades than fit in one INSERT under the 65,535-bind-parameter limit', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const data = batch(4663, 'test-a');
    const tradeCount = 3_700; // 18 columns × 3,700 = 66,600 > 65,535: must split into more than one INSERT
    const extraTrades: Trade[] = [];
    const extraLogs = [];
    for (let i = 0; i < tradeCount; i++) {
      const txHash = `0x${(i + 1).toString(16).padStart(64, '0')}` as Hash;
      extraLogs.push({ chainId: 4663, sourceId: 'test-a', blockNumber: 100n, blockHash, txHash, logIndex: 1,
        address: poolAddress, topics: [], data: '0x' as Hash });
      extraTrades.push({ ...data.trades[0], txHash, logIndex: 1 });
    }
    await repository.saveIndexBatch('test-a', 100n, 100n, {
      rawLogs: [data.rawLogs[0], ...extraLogs], launches: data.launches, venues: data.venues,
      trades: extraTrades, transitions: [],
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(tradeCount);
  });

  it('rejects stale lease owners and preserves job state when a batch transaction fails', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    const now = new Date();
    const old = await repository.claimScanJob('old-worker', now, 1_000);
    const current = await repository.claimScanJob('new-worker', new Date(now.getTime() + 2_000), 10_000);
    expect(current?.id).toBe(old?.id);
    await expect(repository.commitScanJob(old!.id, 'old-worker', old!.generation, batch(4663, 'test-a')))
      .rejects.toThrow(/lease/i);
    await expect(repository.commitScanJob(current!.id, 'new-worker', current!.generation,
      batch(4663, 'test-a', 10n ** 80n))).rejects.toThrow();
    expect((await pool.query("SELECT status FROM scan_jobs WHERE source_id='test-a'")).rows[0].status).toBe('leased');
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(0);
    await repository.commitScanJob(current!.id, 'new-worker', current!.generation, batch(4663, 'test-a'));
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(1);
  });

  it('replays provisional data as certified without counting one trade twice', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'provisional', fromBlock: 100n, toBlock: 100n });
    const now = new Date();
    const live = await repository.claimScanJob('live', now, 10_000);
    await repository.commitScanJob(live!.id, 'live', live!.generation, batch(4663, 'test-a'));
    expect(await repository.getCertifiedFrontier('test-a')).toBe(99n);
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    const history = await repository.claimScanJob('history', new Date(now.getTime() + 1_000), 10_000);
    await repository.commitScanJob(history!.id, 'history', history!.generation, batch(4663, 'test-a'));
    expect(await repository.getCertifiedFrontier('test-a')).toBe(100n);
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(1);
  });

  it('seeds certified coverage from the legacy cursor without erasing gaps', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 105n, { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] });
    await repository.recordScanReport({ sourceId: 'test-a', committedRanges: [],
      missingRanges: [{ fromBlock: 106n, toBlock: 110n, reason: 'archive required' }] });
    await repository.seedCertifiedCoverageFromCursors();
    expect(await repository.getCertifiedFrontier('test-a')).toBe(105n);
    expect((await pool.query("SELECT from_block,to_block FROM scan_jobs WHERE source_id='test-a' AND lane='certified'"))
      .rows).toEqual([{ from_block: '100', to_block: '105' }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM source_gaps WHERE source_id='test-a'"))
      .rows[0].count).toBe(1);
  });

  it('does not certify a recorded gap hidden behind a legacy cursor', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 105n, { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] });
    await repository.recordScanReport({ sourceId: 'test-a', committedRanges: [],
      missingRanges: [{ fromBlock: 102n, toBlock: 103n, reason: 'unverified' }] });
    await repository.seedCertifiedCoverageFromCursors();
    const ranges = await pool.query("SELECT from_block,to_block FROM scan_jobs WHERE source_id='test-a' ORDER BY from_block");
    expect(ranges.rows).toEqual([{ from_block: '100', to_block: '101' }, { from_block: '104', to_block: '105' }]);
    expect(await repository.getCertifiedFrontier('test-a')).toBe(101n);
  });

  it('rejects overlapping certified jobs and a batch outside its leased window', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 101n, toBlock: 110n });
    await expect(repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 105n, toBlock: 120n }))
      .rejects.toThrow(/overlap/i);
    const job = await repository.claimScanJob('worker', new Date(), 10_000);
    await expect(repository.commitScanJob(job!.id, 'worker', job!.generation, batch(4663, 'test-a')))
      .rejects.toThrow(/outside.*range/i);
    expect((await pool.query("SELECT status FROM scan_jobs WHERE id=$1", [job!.id])).rows[0].status).toBe('leased');
  });

  it('claims only a permitted source for an endpoint-specific worker', async () => {
    for (const id of ['test-a', 'test-b']) {
      await repository.registerSource({ id, chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
      await repository.enqueueScanJob({ sourceId: id, lane: 'certified', fromBlock: 100n, toBlock: 100n });
    }
    const claimed = await repository.claimScanJob('worker-b', new Date(), 10_000, ['test-b']);
    expect(claimed?.sourceId).toBe('test-b');
  });

  it('retries a failed rate-limited job only after its cooldown', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    const now = new Date();
    const job = await repository.claimScanJob('worker', now, 10_000);
    await repository.failScanJob(job!.id, 'worker', job!.generation, '429 Too Many Requests');
    expect(await repository.claimScanJob('early', new Date(now.getTime() + 1_000), 10_000)).toBeNull();
    const retry = await repository.claimScanJob('retry', new Date(now.getTime() + 70_000), 10_000);
    expect(retry?.id).toBe(job!.id);
    expect(retry?.leaseOwner).toBe('retry');
  });

  it('bumps generation on every claim so a stale worker cannot commit after a reclaim, even reusing the same worker id', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    const now = new Date();
    const first = await repository.claimScanJob('worker', now, 1_000);
    const reclaimed = await repository.claimScanJob('worker', new Date(now.getTime() + 2_000), 10_000);
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.generation).not.toBe(first?.generation);
    const empty = { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };
    await expect(repository.commitScanJob(first!.id, 'worker', first!.generation, empty)).rejects.toThrow(/lease/i);
    await repository.commitScanJob(reclaimed!.id, 'worker', reclaimed!.generation, empty);
  });

  it('reports a planned frontier past any already-queued certified job, not just the certified frontier', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    expect(await repository.getPlannedCertifiedFrontier('test-a')).toBe(99n);
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 199n });
    // Still pending/unclaimed: the certified frontier hasn't moved, but planning must not re-plan block 100 again.
    expect(await repository.getCertifiedFrontier('test-a')).toBe(99n);
    expect(await repository.getPlannedCertifiedFrontier('test-a')).toBe(199n);
    const job = await repository.claimScanJob('worker', new Date(), 10_000);
    expect(await repository.getPlannedCertifiedFrontier('test-a')).toBe(199n);
    await repository.commitScanJob(job!.id, 'worker', job!.generation, { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] });
    expect(await repository.getCertifiedFrontier('test-a')).toBe(199n);
    expect(await repository.getPlannedCertifiedFrontier('test-a')).toBe(199n);
  });

  it('claims only jobs of the requested lane', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    await repository.replaceProvisionalWindow('test-a', 150n, 150n);
    const provisional = await repository.claimScanJob('worker-p', new Date(), 10_000, undefined, 'provisional');
    expect(provisional?.lane).toBe('provisional');
    expect(provisional?.fromBlock).toBe(150n);
    const certified = await repository.claimScanJob('worker-c', new Date(), 10_000, undefined, 'certified');
    expect(certified?.lane).toBe('certified');
    expect(certified?.fromBlock).toBe(100n);
  });

  it('replaces a stale pending provisional window instead of piling up near-head jobs', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.replaceProvisionalWindow('test-a', 100n, 105n);
    await repository.replaceProvisionalWindow('test-a', 106n, 110n);
    const rows = await pool.query(
      "SELECT from_block,to_block,status FROM scan_jobs WHERE source_id='test-a' AND lane='provisional' ORDER BY from_block");
    expect(rows.rows).toEqual([{ from_block: '106', to_block: '110', status: 'pending' }]);
  });

  it('does not discard a provisional job that is currently leased when a fresher window arrives', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.replaceProvisionalWindow('test-a', 100n, 105n);
    await repository.claimScanJob('worker', new Date(), 10_000, undefined, 'provisional');
    await repository.replaceProvisionalWindow('test-a', 106n, 110n);
    const rows = await pool.query(
      "SELECT from_block,to_block,status FROM scan_jobs WHERE source_id='test-a' AND lane='provisional' ORDER BY from_block");
    expect(rows.rows).toEqual([
      { from_block: '100', to_block: '105', status: 'leased' },
      { from_block: '106', to_block: '110', status: 'pending' },
    ]);
  });

  it('persists protocol activity while defaulting an unclassified legacy trade to user activity', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const data = batch(4663, 'test-a');
    await repository.saveIndexBatch('test-a', 100n, 100n, {
      ...data,
      trades: data.trades.map((trade) => ({ ...trade, activityKind: 'protocol_buyback' as const })),
    });
    const classified = await pool.query('SELECT activity_kind FROM trades WHERE chain_id = 4663');
    expect(classified.rows).toEqual([{ activity_kind: 'protocol_buyback' }]);
    await pool.query('UPDATE trades SET activity_kind = DEFAULT WHERE chain_id = 4663');
    const legacy = await pool.query('SELECT activity_kind FROM trades WHERE chain_id = 4663');
    expect(legacy.rows).toEqual([{ activity_kind: 'user_trade' }]);
  });

  it('does not duplicate a trade when the same block is replayed', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const data = batch(4663, 'test-a');
    await repository.saveIndexBatch('test-a', 100n, 100n, data);
    await repository.saveIndexBatch('test-a', 100n, 100n, data);
    const trades = await pool.query('SELECT count(*)::int AS count FROM trades');
    expect(trades.rows[0].count).toBe(1);
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(100n);
    expect((await repository.getCursor('test-a')).confirmedToBlock).toBe(100n);
  });

  it('does not advance the cursor when a write in the batch fails', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await expect(repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a', 10n ** 80n))).rejects.toThrow();
    const launches = await pool.query('SELECT count(*)::int AS count FROM launches');
    expect(launches.rows[0].count).toBe(0);
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(99n);
  });

  it('keeps the same token address distinct across chains', async () => {
    await repository.registerSource({ id: 'chain-4663', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.registerSource({ id: 'chain-56', chainId: 56, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('chain-4663', 100n, 100n, batch(4663, 'chain-4663'));
    await repository.saveIndexBatch('chain-56', 100n, 100n, batch(56, 'chain-56'));
    const launches = await pool.query('SELECT chain_id FROM launches ORDER BY chain_id');
    expect(launches.rows.map((row) => row.chain_id)).toEqual([56, 4663]);
  });

  it('includes degraded sources in the pending work list', async () => {
    for (const id of ['backfilling', 'degraded', 'caught-up']) {
      await repository.registerSource({ id, chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    }
    await pool.query("UPDATE sources SET status = 'degraded' WHERE id = 'degraded'");
    await pool.query("UPDATE sources SET status = 'caught_up' WHERE id = 'caught-up'");
    const pending = await repository.listPendingSources();
    expect(pending.map((source) => source.sourceId).sort()).toEqual(['backfilling', 'degraded']);
  });

  it('sets a source caught up only after its checkpoint reaches the observed safe head', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await expect(repository.setSourceStatus('test-a', 'caught_up', 100n)).rejects.toThrow(/checkpoint/i);
    await repository.saveIndexBatch('test-a', 100n, 100n, { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] });
    await repository.setSourceStatus('test-a', 'caught_up', 100n);
    expect((await repository.getCursor('test-a')).status).toBe('caught_up');
  });

  it('retracts a reorged block and allows it to be replayed', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const data = batch(4663, 'test-a');
    await repository.saveIndexBatch('test-a', 100n, 100n, data);
    await repository.retractBlocks(4663, 100n);
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(0);
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(99n);
    await repository.saveIndexBatch('test-a', 100n, 100n, data);
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(1);
  });

  it('invalidates intersecting/downstream jobs and rejects a stale leased job before retracting data', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    const before = await repository.claimScanJob('worker', new Date(), 10_000);
    await repository.commitScanJob(before!.id, 'worker', before!.generation, batch(4663, 'test-a'));
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 101n, toBlock: 101n });
    const stale = await repository.claimScanJob('stale-worker', new Date(), 10_000);
    await repository.replaceProvisionalWindow('test-a', 200n, 200n);

    await repository.invalidateJobsFrom(4663, 101n);

    await expect(repository.commitScanJob(stale!.id, 'stale-worker', stale!.generation,
      { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] })).rejects.toThrow(/unknown scan job/i);
    const remaining = await pool.query("SELECT from_block, to_block, lane FROM scan_jobs WHERE source_id = 'test-a' ORDER BY from_block");
    expect(remaining.rows).toEqual([{ from_block: '100', to_block: '100', lane: 'certified' }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM trades')).rows[0].count).toBe(1);
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(100n);
  });

  it('does not touch jobs entirely before the fork block', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 100n });
    await repository.invalidateJobsFrom(4663, 200n);
    const remaining = await pool.query("SELECT status FROM scan_jobs WHERE source_id = 'test-a'");
    expect(remaining.rows).toEqual([{ status: 'pending' }]);
  });

  it('lets a new certified job be planned for the range a rejected stale job used to occupy', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 105n });
    await repository.invalidateJobsFrom(4663, 100n);
    await expect(repository.enqueueScanJob({ sourceId: 'test-a', lane: 'certified', fromBlock: 100n, toBlock: 102n }))
      .resolves.toBeDefined();
  });

  it('projects V2 status and exact venue boundaries from lifecycle logs, then restores them on reorg', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    await repository.registerSource({ id: 'pons-v2-lifecycle', chainId: 4663, version: 'v2-lifecycle', factoryAddress: factory, startBlock: 101n });
    const initial = batch(4663, 'pons-v2');
    initial.launches[0].protocolVersion = 'v2';
    initial.launches[0].v4PoolFee = 0;
    initial.launches[0].v4TickSpacing = 200;
    initial.venues[0].kind = 'curve';
    initial.venues[0].id = '4663:curve:0x3333333333333333333333333333333333333333';
    initial.trades = [];
    initial.rawLogs = [initial.rawLogs[0]];
    await repository.saveIndexBatch('pons-v2', 100n, 100n, initial);

    const sweepTx = `0x${'7'.repeat(64)}` as Hash;
    const gradTx = `0x${'8'.repeat(64)}` as Hash;
    const initLogId = logKey(4663, blockHash, gradTx, 2);
    const sweepLog = { chainId: 4663, sourceId: 'pons-v2-lifecycle', blockNumber: 101n, blockHash,
      txHash: sweepTx, logIndex: 4, address: factory, topics: [], data: '0x' as Hash };
    const gradLog = { ...sweepLog, blockNumber: 102n, txHash: gradTx, logIndex: 5 };
    const initLog = { ...gradLog, logIndex: 2, address: poolAddress };
    await repository.saveIndexBatch('pons-v2-lifecycle', 101n, 101n, {
      rawLogs: [sweepLog], launches: [], venues: [], trades: [],
      transitions: [{ chainId: 4663, tokenAddress: token, sourceId: 'pons-v2-lifecycle',
        sourceLogId: logKey(4663, blockHash, sweepTx, 4), phase: 1, kind: 'swept',
        blockNumber: 101n, blockHash, txHash: sweepTx, logIndex: 4 }],
    });
    const v4Venue = { id: `4663:v4_pool:0x${'9'.repeat(64)}`, chainId: 4663, tokenAddress: token,
      kind: 'v4_pool' as const, ref: `0x${'9'.repeat(64)}`, sourceId: 'pons-v2-lifecycle',
      sourceLogId: initLogId, effectiveFromBlock: 102n, effectiveFromLogIndex: 2,
      effectiveToBlock: null, effectiveToLogIndex: null, official: true };
    await repository.saveIndexBatch('pons-v2-lifecycle', 102n, 102n, {
      rawLogs: [initLog, gradLog], launches: [], venues: [v4Venue], trades: [],
      transitions: [{ chainId: 4663, tokenAddress: token, sourceId: 'pons-v2-lifecycle',
        sourceLogId: logKey(4663, blockHash, gradTx, 5), phase: 2, kind: 'graduated',
        blockNumber: 102n, blockHash, txHash: gradTx, logIndex: 5 }],
    });
    await repository.saveIndexBatch('pons-v2-lifecycle', 102n, 102n, {
      rawLogs: [initLog, gradLog], launches: [], venues: [v4Venue], trades: [], transitions: [],
    });
    const projected = await pool.query('SELECT lifecycle_status, v4_pool_fee, v4_tick_spacing FROM launches WHERE chain_id = 4663');
    expect(projected.rows[0]).toEqual({ lifecycle_status: 'graduated', v4_pool_fee: 0, v4_tick_spacing: 200 });
    expect((await pool.query('SELECT count(*)::int AS count FROM lifecycle_transitions')).rows[0].count).toBe(2);
    expect((await pool.query("SELECT effective_to_block, effective_to_log_index FROM venues WHERE kind = 'curve'")).rows[0])
      .toEqual({ effective_to_block: '101', effective_to_log_index: 4 });
    expect((await pool.query("SELECT effective_from_log_index FROM venues WHERE kind = 'v4_pool'")).rows[0].effective_from_log_index).toBe(2);

    await repository.registerSource({ id: 'pons-v2-v4-pool', chainId: 4663, version: 'v4-trades', factoryAddress: poolAddress, startBlock: 102n });
    const swap: Trade = { ...batch(4663, 'pons-v2').trades[0], venueId: v4Venue.id,
      blockNumber: 102n, txHash: gradTx, logIndex: 1 };
    const swapLog = { ...initLog, sourceId: 'pons-v2-v4-pool', logIndex: 1 };
    await expect(repository.saveIndexBatch('pons-v2-v4-pool', 102n, 102n, {
      rawLogs: [swapLog], launches: [], venues: [], trades: [swap], transitions: [],
    })).rejects.toThrow(/venue.*position/i);
    expect((await repository.getCursor('pons-v2-v4-pool')).scannedToBlock).toBe(101n);
    await repository.saveIndexBatch('pons-v2-v4-pool', 102n, 102n, {
      rawLogs: [{ ...swapLog, logIndex: 3 }], launches: [], venues: [],
      trades: [{ ...swap, logIndex: 3 }], transitions: [],
    });
    expect((await pool.query("SELECT count(*)::int AS count FROM trades WHERE venue_id = $1", [v4Venue.id])).rows[0].count).toBe(1);

    await repository.retractBlocks(4663, 102n);
    expect((await pool.query('SELECT lifecycle_status FROM launches WHERE chain_id = 4663')).rows[0].lifecycle_status).toBe('swept');
    expect((await pool.query("SELECT count(*)::int AS count FROM venues WHERE kind = 'v4_pool'")).rows[0].count).toBe(0);
    await repository.retractBlocks(4663, 101n);
    expect((await pool.query('SELECT lifecycle_status FROM launches WHERE chain_id = 4663')).rows[0].lifecycle_status).toBe('trading');
    expect((await pool.query("SELECT effective_to_block, effective_to_log_index FROM venues WHERE kind = 'curve'")).rows[0])
      .toEqual({ effective_to_block: null, effective_to_log_index: null });
  });

  it('keeps the lifecycle cursor unchanged if a transition has no raw-log provenance', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    const initial = batch(4663, 'pons-v2');
    initial.launches[0].protocolVersion = 'v2';
    initial.venues[0].kind = 'curve';
    initial.trades = [];
    initial.rawLogs = [initial.rawLogs[0]];
    await repository.saveIndexBatch('pons-v2', 100n, 100n, initial);
    await repository.registerSource({ id: 'pons-v2-lifecycle', chainId: 4663, version: 'v2-lifecycle', factoryAddress: factory, startBlock: 101n });
    await expect(repository.saveIndexBatch('pons-v2-lifecycle', 101n, 101n, {
      rawLogs: [], launches: [], venues: [], trades: [],
      transitions: [{ chainId: 4663, tokenAddress: token, sourceId: 'pons-v2-lifecycle', sourceLogId: 'missing',
        phase: 1, kind: 'swept', blockNumber: 101n, blockHash, txHash, logIndex: 4 }],
    })).rejects.toThrow();
    expect((await repository.getCursor('pons-v2-lifecycle')).scannedToBlock).toBe(100n);
    expect((await pool.query('SELECT lifecycle_status FROM launches WHERE chain_id = 4663')).rows[0].lifecycle_status).toBe('trading');
    await expect(repository.saveIndexBatch('pons-v2-lifecycle', 101n, 101n, {
      rawLogs: [], launches: [], venues: [], trades: [],
      transitions: [{ chainId: 4663, tokenAddress: token, sourceId: 'pons-v2-lifecycle',
        sourceLogId: initial.launches[0].sourceLogId,
        phase: 1, kind: 'swept', blockNumber: 101n, blockHash, txHash, logIndex: 4 }],
    })).rejects.toThrow(/transition.*log/i);
    expect((await repository.getCursor('pons-v2-lifecycle')).scannedToBlock).toBe(100n);
  });

  it('allows an official V4 pool source to be registered again if its Initialize block reorgs', async () => {
    const id = `pons-v2-v4:0x${'9'.repeat(64)}`;
    await repository.registerSource({ id, chainId: 4663, version: 'v2-v4', factoryAddress: poolAddress, startBlock: 102n });
    await repository.saveIndexBatch(id, 102n, 102n, { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] });
    await repository.retractBlocks(4663, 102n);
    await repository.registerSource({ id, chainId: 4663, version: 'v2-v4', factoryAddress: poolAddress, startBlock: 103n });
    expect((await repository.getCursor(id)).scannedToBlock).toBe(102n);
  });

  it('fills immutable V2 pool terms for an older indexed launch without changing its origin', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    const initial = batch(4663, 'pons-v2');
    initial.launches[0].protocolVersion = 'v2';
    initial.venues[0].kind = 'curve';
    initial.trades = [];
    initial.rawLogs = [initial.rawLogs[0]];
    await repository.saveIndexBatch('pons-v2', 100n, 100n, initial);
    await repository.setV2PoolTerms(4663, token, 0, 200);
    await repository.setV2PoolTerms(4663, token, 0, 200);
    const result = await pool.query('SELECT v4_pool_fee, v4_tick_spacing, lifecycle_status, source_log_id FROM launches');
    expect(result.rows[0]).toEqual({ v4_pool_fee: 0, v4_tick_spacing: 200,
      lifecycle_status: 'trading', source_log_id: initial.launches[0].sourceLogId });
    await expect(repository.setV2PoolTerms(4663, token, 0, 100)).rejects.toThrow(/terms.*conflict/i);
  });

  it('invalidates an authoritative phase observation after a new transition or reorg', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    const initial = batch(4663, 'pons-v2');
    initial.launches[0].protocolVersion = 'v2';
    initial.venues[0].kind = 'curve';
    initial.trades = [];
    initial.rawLogs = [initial.rawLogs[0]];
    await repository.saveIndexBatch('pons-v2', 100n, 100n, initial);
    expect((await repository.listV2PhaseAuditCandidates(4663, 10)).map((row) => row.tokenAddress)).toEqual([token]);
    await repository.recordV2PhaseObservation(4663, token, 'trading', {
      status: 'verified', observedPhase: 0, blockNumber: 105n, reason: null,
    });
    expect(await repository.listV2PhaseAuditCandidates(4663, 10)).toEqual([]);
    await repository.registerSource({ id: 'pons-v2-lifecycle', chainId: 4663, version: 'v2-lifecycle', factoryAddress: factory, startBlock: 106n });
    const sweepTx = `0x${'7'.repeat(64)}` as Hash;
    const sweepLog = { chainId: 4663, sourceId: 'pons-v2-lifecycle', blockNumber: 106n, blockHash,
      txHash: sweepTx, logIndex: 4, address: factory, topics: [], data: '0x' as Hash };
    await repository.saveIndexBatch('pons-v2-lifecycle', 106n, 106n, { rawLogs: [sweepLog], launches: [], venues: [], trades: [],
      transitions: [{ chainId: 4663, tokenAddress: token, sourceId: 'pons-v2-lifecycle',
        sourceLogId: logKey(4663, blockHash, sweepTx, 4), phase: 1, kind: 'swept',
        blockNumber: 106n, blockHash, txHash: sweepTx, logIndex: 4 }] });
    expect((await repository.listV2PhaseAuditCandidates(4663, 10)).map((row) => row.lifecycleStatus)).toEqual(['swept']);
    await repository.recordV2PhaseObservation(4663, token, 'swept', {
      status: 'verified', observedPhase: 1, blockNumber: 106n, reason: null,
    });
    await repository.retractBlocks(4663, 106n);
    expect((await repository.listV2PhaseAuditCandidates(4663, 10)).map((row) => row.lifecycleStatus)).toEqual(['trading']);
  });

  it('keeps launch, venue and trade provenance linked to raw logs', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a'));
    const launchLog = await pool.query('SELECT r.address FROM launches l JOIN raw_logs r ON r.id = l.source_log_id');
    const venueLog = await pool.query('SELECT r.address FROM venues v JOIN raw_logs r ON r.id = v.source_log_id');
    const tradeLog = await pool.query('SELECT r.address FROM trades t JOIN raw_logs r ON r.id = t.source_log_id');
    expect(launchLog.rows[0].address).toBe(factory);
    expect(venueLog.rows[0].address).toBe(factory);
    expect(tradeLog.rows[0].address).toBe(poolAddress);
  });

  it('rejects reusing a source ID for another chain', async () => {
    await repository.registerSource({ id: 'same-id', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await expect(repository.registerSource({ id: 'same-id', chainId: 56, version: 'v1', factoryAddress: factory, startBlock: 100n })).rejects.toThrow(/source configuration/i);
    expect((await repository.getCursor('same-id')).chainId).toBe(4663);
  });

  it('rejects a batch that contains data from another chain', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await expect(repository.saveIndexBatch('test-a', 100n, 100n, batch(56, 'test-a'))).rejects.toThrow(/chain/i);
    expect((await repository.getCursor('test-a')).scannedToBlock).toBe(99n);
  });

  it('replaces observed block hashes after a reorg', async () => {
    const replacement = `0x${'7'.repeat(64)}` as Hash;
    await repository.recordObservedBlock(4663, 108n, blockHash);
    await repository.recordObservedBlock(4663, 109n, blockHash);
    expect((await repository.getObservedBlocks(4663, 108n, 109n)).map((block) => block.hash)).toEqual([blockHash, blockHash]);
    await repository.retractBlocks(4663, 109n);
    expect((await repository.getObservedBlocks(4663, 108n, 109n)).map((block) => block.number)).toEqual([108n]);
    await repository.recordObservedBlock(4663, 109n, replacement);
    expect((await repository.getObservedBlocks(4663, 109n, 109n))[0].hash).toBe(replacement);
  });

  it('uses raw log block hashes to find the earliest reorged data block', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a'));
    expect(await repository.getObservedBlocks(4663, 100n, 100n)).toEqual([{ number: 100n, hash: blockHash }]);
  });

  it('preserves V3 price rationals larger than uint256 amounts', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const data = batch(4663, 'test-a');
    data.trades[0].priceNumeratorRaw = 10n ** 100n;
    data.trades[0].priceDenominatorRaw = 10n ** 90n;
    await repository.saveIndexBatch('test-a', 100n, 100n, data);
    const result = await pool.query('SELECT price_numerator_raw, price_denominator_raw FROM trades');
    expect(result.rows[0].price_numerator_raw).toBe((10n ** 100n).toString());
    expect(result.rows[0].price_denominator_raw).toBe((10n ** 90n).toString());
  });

  it('replaces candle projections idempotently after a reorg or price correction', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a'));
    const candle = { chainId: 4663, tokenAddress: token, quoteAssetAddress: quote, intervalSeconds: 60,
      bucketStart: 1_699_999_980, open: '0.1', high: '0.1', low: '0.1', close: '0.1', quoteVolumeRaw: 100n };
    await repository.replaceCandles(4663, token, 60, [candle]);
    await repository.replaceCandles(4663, token, 60, [candle]);
    expect((await pool.query('SELECT count(*)::int AS count FROM candles')).rows[0].count).toBe(1);
    await repository.replaceCandles(4663, token, 60, [{ ...candle, close: '0.2', quoteVolumeRaw: 200n }]);
    const corrected = await pool.query('SELECT close, quote_volume_raw FROM candles');
    expect(corrected.rows[0]).toEqual({ close: '0.2', quote_volume_raw: '200' });
    await repository.replaceCandles(4663, token, 60, []);
    expect((await pool.query('SELECT count(*)::int AS count FROM candles')).rows[0].count).toBe(0);
  });
});

describe('PostgreSQL API store', () => {
  it('has a token-time index for bounded historical candle pages', async () => {
    const result = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'trades'");
    expect(result.rows.map((row) => row.indexname)).toContain('trades_token_timestamp_idx');
  });

  it('shows a complete launch volume and last verified trade price, but not an unrelated pool', async () => {
    const tradeTime = Math.floor(Date.now() / 1000) - 60;
    const ids = ['pons-v1-legacy', 'pons-v1-active', 'pons-v2', 'pons-v1-legacy-trades',
      'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];
    for (const id of ids) {
      await repository.registerSource({ id, chainId: 4663, version: 'test', factoryAddress: factory, startBlock: 100n });
      const data = id === 'pons-v1-active' ? batch(4663, id) : { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };
      if (id === 'pons-v1-active') data.trades[0].timestamp = tradeTime;
      await repository.saveIndexBatch(id, 100n, 100n, data);
      await repository.setSourceStatus(id, 'caught_up', 100n);
    }
    await repository.recordObservedBlock(4663, 100n, blockHash);
    const store = createApiStore(pool);
    expect((await store.getCoverage()).complete).toBe(true);
    expect((await store.listLaunches({ limit: 10 })).items[0].officialVolume24h).toBe('0.1');
    const detail = await store.getLaunch(4663, token);
    expect(detail?.officialVolume24h).toBe('0.1');
    expect(detail?.priceQuote).toBe('0.1');
    expect(detail?.priceStale).toBe(false);
    expect((await store.listCandles(4663, token, 60)).items).toEqual([{
      intervalSeconds: 60, bucketStart: Math.floor(tradeTime / 60) * 60,
      open: '0.1', high: '0.1', low: '0.1', close: '0.1', quoteVolume: '0.1',
    }]);
    expect((await store.listCandles(4663, token, 60)).complete).toBe(true);
    await pool.query('UPDATE trades SET price_numerator_raw = NULL WHERE chain_id = 4663');
    expect(await store.listCandles(4663, token, 60)).toEqual({ items: [], complete: false });
    await pool.query("UPDATE launches SET protocol_version = 'v2', lifecycle_status = 'swept' WHERE chain_id = 4663");
    expect((await store.getLaunch(4663, token))?.priceStale).toBe(true);
    await pool.query("UPDATE trades SET price_numerator_raw = 1 WHERE chain_id = 4663");
    await pool.query("UPDATE launches SET lifecycle_status = 'graduated' WHERE chain_id = 4663");
    expect((await store.getLaunch(4663, token))?.priceStale).toBe(true);
    await pool.query("UPDATE venues SET kind = 'v4_pool' WHERE chain_id = 4663");
    expect((await store.getLaunch(4663, token))?.priceStale).toBe(false);
  });

  it('reports a launch as fully covered while an unrelated V4 pool source is still behind', async () => {
    const tradeTime = Math.floor(Date.now() / 1000) - 60;
    const ids = ['pons-v1-legacy', 'pons-v1-active', 'pons-v2', 'pons-v1-legacy-trades',
      'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];
    for (const id of ids) {
      await repository.registerSource({ id, chainId: 4663, version: 'test', factoryAddress: factory, startBlock: 100n });
      const data = id === 'pons-v1-active' ? batch(4663, id) : { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };
      if (id === 'pons-v1-active') data.trades[0].timestamp = tradeTime;
      await repository.saveIndexBatch(id, 100n, 100n, data);
      await repository.setSourceStatus(id, 'caught_up', 100n);
    }
    await repository.recordObservedBlock(4663, 100n, blockHash);
    const otherToken = '0x8888888888888888888888888888888888888888' as Address;
    const otherPool = '0x9999999999999999999999999999999999999999' as Address;
    await repository.registerSource({ id: `pons-v2-v4:${otherPool}`, chainId: 4663, version: 'v2-v4',
      factoryAddress: factory, startBlock: 100n });
    const otherVenue: Venue = { id: `4663:v4_pool:${otherPool}`, chainId: 4663, tokenAddress: otherToken, kind: 'v4_pool',
      ref: otherPool, sourceId: 'pons-v2-lifecycle', sourceLogId: logKey(4663, blockHash, txHash, 9),
      effectiveFromBlock: 101n, effectiveToBlock: null, official: true };
    const otherLaunch: Launch = { chainId: 4663, tokenAddress: otherToken, name: 'Other', symbol: 'OTH', tokenDecimals: 18,
      platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2-lifecycle', sourceLogId: logKey(4663, blockHash, txHash, 9),
      factoryAddress: factory, deployerAddress: factory, launchBlock: 101n, launchTxHash: txHash,
      quoteAsset: { address: quote, symbol: 'WETH', decimals: 18 }, lifecycleStatus: 'graduated' };
    await repository.saveIndexBatch('pons-v2-lifecycle', 101n, 101n, {
      rawLogs: [{ chainId: 4663, sourceId: 'pons-v2-lifecycle', blockNumber: 101n, blockHash, txHash, logIndex: 9,
        address: otherPool, topics: [], data: '0x' }],
      launches: [otherLaunch], venues: [otherVenue], trades: [], transitions: [],
    });
    const store = createApiStore(pool);
    expect((await store.getCoverage()).complete).toBe(false);
    expect((await store.listLaunches({ limit: 10 })).items.find((item) => item.tokenAddress === token)?.officialVolume24h)
      .toBe('0.1');
    const detail = await store.getLaunch(4663, token);
    expect(detail?.officialVolume24h).toBe('0.1');
    expect(detail?.coverageStatus).toBe('caught_up');
  });

  it('shows a new launch from a provisional near-head job while its factory history is still backfilling', async () => {
    await repository.registerSource({ id: 'pons-v1-active', chainId: 4663, version: 'test', factoryAddress: factory, startBlock: 100n });
    await repository.enqueueScanJob({ sourceId: 'pons-v1-active', lane: 'provisional', fromBlock: 100n, toBlock: 100n });
    const job = await repository.claimScanJob('worker', new Date(), 10_000);
    await repository.commitScanJob(job!.id, 'worker', job!.generation, batch(4663, 'pons-v1-active'));
    await repository.recordObservedBlock(4663, 100n, blockHash);
    const store = createApiStore(pool);
    const listed = await store.listLaunches({ limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ tokenAddress: token, officialVolume24h: null, coverageStatus: 'backfilling' });
    expect((await store.getCoverage()).complete).toBe(false);
  });

  it('requires lifecycle and discovered V4 sources without requiring a nonexistent V4 umbrella', async () => {
    const ids = ['pons-v1-legacy', 'pons-v1-active', 'pons-v2', 'pons-v1-legacy-trades',
      'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];
    for (const id of ids) {
      await repository.registerSource({ id, chainId: 4663, version: 'test', factoryAddress: factory, startBlock: 100n });
      const data = id === 'pons-v2' ? batch(4663, id) : { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };
      if (id === 'pons-v2') {
        data.launches[0].protocolVersion = 'v2';
        data.venues[0].kind = 'curve';
        data.trades = [];
        data.rawLogs = [data.rawLogs[0]];
      }
      await repository.saveIndexBatch(id, 100n, 100n, data);
      await repository.setSourceStatus(id, 'caught_up', 100n);
    }
    await repository.recordObservedBlock(4663, 100n, blockHash);
    const store = createApiStore(pool);
    expect((await store.getCoverage()).complete).toBe(false);
    await repository.recordV2PhaseObservation(4663, token, 'trading', {
      status: 'verified', observedPhase: 0, blockNumber: 100n, reason: null,
    });
    expect(await store.getCoverage()).toEqual({ complete: true, pendingSourceIds: [], missingRanges: [] });
  });

  it('persists missing block ranges and removes them only after successful repair', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    await repository.recordScanReport({ sourceId: 'pons-v2', committedRanges: [],
      missingRanges: [{ fromBlock: 100n, toBlock: 120n, reason: 'archive required' }] });
    const store = createApiStore(pool);
    expect((await store.getCoverage()).missingRanges).toEqual([
      { sourceId: 'pons-v2', fromBlock: '100', toBlock: '120', reason: 'archive required' },
    ]);
    await repository.recordScanReport({ sourceId: 'pons-v2', committedRanges: [{ fromBlock: 100n, toBlock: 109n }], missingRanges: [] });
    expect((await store.getCoverage()).missingRanges).toEqual([
      { sourceId: 'pons-v2', fromBlock: '110', toBlock: '120', reason: 'archive required' },
    ]);
    await repository.recordScanReport({ sourceId: 'pons-v2', committedRanges: [{ fromBlock: 110n, toBlock: 120n }], missingRanges: [] });
    expect((await store.getCoverage()).missingRanges).toEqual([]);
  });

  it('repairs a gap atomically with checkpoint advancement even if report persistence never runs', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    await repository.recordScanReport({ sourceId: 'pons-v2', committedRanges: [],
      missingRanges: [{ fromBlock: 100n, toBlock: 120n, reason: 'archive required' }] });
    const empty = { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };
    await repository.saveIndexBatch('pons-v2', 100n, 109n, empty);
    expect((await createApiStore(pool).getCoverage()).missingRanges).toEqual([
      { sourceId: 'pons-v2', fromBlock: '110', toBlock: '120', reason: 'archive required' },
    ]);
    await repository.saveIndexBatch('pons-v2', 110n, 120n, empty);
    expect((await createApiStore(pool).getCoverage()).missingRanges).toEqual([]);
  });

  it('does not mix an unrelated source gap into Pons coverage', async () => {
    await repository.registerSource({ id: 'unrelated', chainId: 56, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.recordScanReport({ sourceId: 'unrelated', committedRanges: [],
      missingRanges: [{ fromBlock: 100n, toBlock: 101n, reason: 'other chain' }] });
    expect((await createApiStore(pool).getCoverage()).missingRanges).toEqual([]);
  });

  it('notifies the API after a committed launch and trade batch', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const bus = new ApiEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.type));
    const stop = await listenForDatabaseEvents(pool, bus);
    try {
      await repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a'));
      for (let i = 0; i < 20 && seen.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(seen).toContain('launch.changed');
      expect(seen).toContain('trade.created');
      expect(seen).toContain('coverage.changed');
    } finally {
      unsubscribe();
      await stop();
    }
  });

  it('does not claim complete coverage without an observed safe head', async () => {
    for (const id of ['pons-v1-legacy', 'pons-v1-active', 'pons-v2', 'pons-v1-trades', 'pons-v2-curve', 'pons-v2-v4']) {
      await repository.registerSource({ id, chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    }
    await pool.query("UPDATE sources SET status = 'caught_up'");
    expect((await createApiStore(pool).getCoverage()).complete).toBe(false);
  });

  it('returns chain-scoped launches and stable, exact trade pages without pretending coverage is complete', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    const data = batch(4663, 'test-a');
    const secondTx = `0x${'7'.repeat(64)}` as Hash;
    const secondTrade = { ...data.trades[0], txHash: secondTx, logIndex: 2, activityKind: 'protocol_buyback' as const };
    await repository.saveIndexBatch('test-a', 100n, 100n, {
      ...data,
      rawLogs: [...data.rawLogs, { ...data.rawLogs[1], txHash: secondTx, logIndex: 2 }],
      trades: [...data.trades, secondTrade],
    });
    const store = createApiStore(pool);
    const listed = await store.listLaunches({ limit: 10, chainId: 4663 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ tokenAddress: token, officialVolume24h: null, coverageStatus: 'backfilling' });
    expect((await store.listLaunches({ limit: 10, chainId: 56 })).items).toEqual([]);
    expect(await store.getLaunch(56, token)).toBeNull();
    const detail = await store.getLaunch(4663, token);
    expect(detail?.officialVenues).toHaveLength(1);
    expect(detail?.priceQuote).toBeNull();
    const first = await store.listTrades(4663, token, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await store.listTrades(4663, token, { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((trade) => `${trade.txHash}:${trade.logIndex}`)).size).toBe(2);
    expect([...first.items, ...second.items].map((trade) => trade.activityKind)).toContain('protocol_buyback');
    expect([...first.items, ...second.items].every((trade) => trade.traderAddress === trader.toLowerCase())).toBe(true);
  });

  it('filters launches by search term (name/symbol) and by lifecycle status', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a'));
    const store = createApiStore(pool);

    expect((await store.listLaunches({ limit: 10, search: 'exam' })).items).toHaveLength(1);
    expect((await store.listLaunches({ limit: 10, search: 'EX' })).items).toHaveLength(1);
    expect((await store.listLaunches({ limit: 10, search: 'nonexistent' })).items).toEqual([]);

    expect((await store.listLaunches({ limit: 10, status: 'trading' })).items).toHaveLength(1);
    expect((await store.listLaunches({ limit: 10, status: 'swept' })).items).toEqual([]);
  });
});

describe('venue discovery for trade indexing', () => {
  it('provides persisted V2 pool terms to lifecycle verification', async () => {
    await repository.registerSource({ id: 'pons-v2', chainId: 4663, version: 'v2', factoryAddress: factory, startBlock: 100n });
    const initial = batch(4663, 'pons-v2');
    initial.launches[0].protocolVersion = 'v2';
    initial.launches[0].v4PoolFee = 0;
    initial.launches[0].v4TickSpacing = 200;
    initial.venues[0].kind = 'curve';
    initial.trades = [];
    initial.rawLogs = [initial.rawLogs[0]];
    await repository.saveIndexBatch('pons-v2', 100n, 100n, initial);
    const [context] = await createVenueStore(pool).listOfficial('curve', 4663);
    expect(context.launch.v4PoolFee).toBe(0);
    expect(context.launch.v4TickSpacing).toBe(200);
  });

  it('loads only official venues with their chain-scoped launch context', async () => {
    await repository.registerSource({ id: 'test-a', chainId: 4663, version: 'v1', factoryAddress: factory, startBlock: 100n });
    await repository.saveIndexBatch('test-a', 100n, 100n, batch(4663, 'test-a'));
    const store = createVenueStore(pool);
    const contexts = await store.listOfficial('v3_pool', 4663);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].launch.tokenAddress).toBe(token);
    expect(contexts[0].venue.ref).toBe(poolAddress);
    expect(await store.listOfficial('curve', 4663)).toEqual([]);
    expect(await store.listOfficial('v3_pool', 56)).toEqual([]);
  });
});
