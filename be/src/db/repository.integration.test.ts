import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Address, Hash } from 'viem';
import type { IndexBatch, Launch, Trade, Venue } from '../domain/types.js';
import { logKey } from '../domain/ids.js';
import { createDatabase } from './client.js';
import { createRepository } from './repository.js';

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
    priceNumeratorRaw: 1n,
    priceDenominatorRaw: 10n,
  };
  return {
    rawLogs: [
      { chainId, sourceId, blockNumber: 100n, blockHash, txHash, logIndex: 0, address: factory, topics: [], data: '0x' },
      { chainId, sourceId, blockNumber: 100n, blockHash, txHash, logIndex: 1, address: poolAddress, topics: [], data: '0x' },
    ],
    launches: [launch],
    venues: [venue],
    trades: [trade],
  };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
});

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE trades, venues, launches, raw_logs, candles, observed_blocks, sources RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('index batch repository', () => {
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
