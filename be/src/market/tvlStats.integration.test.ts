import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { __resetUsdPriceCacheForTests } from './usdPricing.js';
import { readCurrentTvl } from './tvlStats.js';
import { upsertQuoteFeed } from './quotePricing/feedRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const quote = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const quoteFeed = '0x61b7e5650328764b076a108eff5fa7282a1b9ad2';
const token = '0x6e11355902da955db596b69eb8c89fea06f87446';
const curve = '0xf17871c268122408f677073066bb36fecddc1ba0';
const factory = '0x1111111111111111111111111111111111111111';
const input = { chainId: 4663, token, quote, quoteDecimals: 6, tokenDecimals: 18,
  protocolVersion: 'v2', factory, lifecycleStatus: 'trading',
  venue: { kind: 'curve' as const, ref: curve }, v4PoolFee: null, v4TickSpacing: null };

beforeAll(async () => {
  await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: quote, feedAddress: quoteFeed,
    aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
});

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = $1', [quote]);
  await pool.end();
});

beforeEach(__resetUsdPriceCacheForTests);

describe('readCurrentTvl', () => {
  it('returns real USDG collateral with oracle provenance for a live curve', async () => {
    const client = { getBlockNumber: async () => 77_455_470n,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') return [1n, 99_992_674n, 1n, 1_790_782_723n, 1n];
        if (functionName === 'getLaunchedToken') return { exists: true, phase: 0, token, curve };
        if (functionName === 'realQuoteReserve') return 15_700_717n;
        throw new Error(functionName);
      }) };
    expect(await readCurrentTvl(pool, client, input, () => 1_790_859_457_000)).toEqual({
      tvlUsd: '15.69956676', tvlBasis: 'curve_real_quote', tvlBlockNumber: '77455470',
      tvlPriceSource: 'chainlink', tvlPriceUpdatedAt: 1_790_782_723, tvlUnavailableReason: null,
    });
  });

  it('rejects a stale curve venue when factory phase has already advanced', async () => {
    const client = { getBlockNumber: async () => 77_455_470n,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') return [1n, 99_992_674n, 1n, 1_790_782_723n, 1n];
        if (functionName === 'getLaunchedToken') return { exists: true, phase: 2, token, curve };
        throw new Error('closed curve must not be read');
      }) };
    expect((await readCurrentTvl(pool, client, input, () => 1_790_859_457_000)).tvlUnavailableReason)
      .toBe('venue_phase_mismatch');
    expect(client.readContract.mock.calls.some(([params]) => params.functionName === 'realQuoteReserve')).toBe(false);
  });

  it('reports a stale quote oracle as unavailable USD pricing', async () => {
    const client = { getBlockNumber: async () => 77_455_470n,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') return [1n, 99_992_674n, 1n, 1_790_000_000n, 1n];
        throw new Error('venue must not be read without a current USD price');
      }) };
    expect((await readCurrentTvl(pool, client, input, () => 1_790_859_457_000)).tvlUnavailableReason)
      .toBe('quote_price_unavailable');
  });
});
