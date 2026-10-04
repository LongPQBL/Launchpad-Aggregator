import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { __resetUsdPriceCacheForTests } from '../market/usdPricing.js';
import { createApiStore } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const store = createApiStore(pool);
const source = 'envio-store-test';
const tokens = ['0x1313131313131313131313131313131313131313', '0x1414141414141414141414141414141414141414',
  '0x1515151515151515151515151515151515151515'];
const blockHash = '0x' + 'a'.repeat(64);
const txHash = '0x' + 'b'.repeat(64);
const blockNumber = 999999999n;
const rawLogId = `4663:${blockHash}:${txHash}:4`;
// Real zero-address convention for native ETH (Pons' quote-asset convention) — matches
// usdPricing.ts's FEEDS map, which is keyed by address, not symbol (final-review Critical 1).
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
// Computed at test-run time, not hardcoded, so this never drifts into readUsdPrice's 24h staleness
// rejection as real wall-clock time passes — same fix applied to usdPricing.test.ts this session.
const FRESH_FEED_UPDATED_AT = BigInt(Math.floor(Date.now() / 1000) - 60);

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
    VALUES ($1,4663,'v1',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [source, tokens[0]]);
  await pool.query(`INSERT INTO raw_logs (id,chain_id,source_id,block_number,block_hash,tx_hash,log_index,address,topics,data)
    VALUES ($1,4663,$2,$3,$4,$5,4,$6,'[]','0x') ON CONFLICT DO NOTHING`,
  [rawLogId, source, blockNumber.toString(), blockHash, txHash, tokens[0]]);
  for (const [i, logIndex] of [5, 4, 2].entries()) {
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,$3,$4,'T',18,'pons','v1',$1,$1,$5,$6,$7,$1,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
    [tokens[i], source, i === 1 ? rawLogId : null, `Token${i}`, blockNumber.toString(), txHash, logIndex]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM launches WHERE token_address = ANY($1)', [tokens]);
  await pool.query('DELETE FROM raw_logs WHERE id = $1', [rawLogId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('listLaunches without raw log provenance', () => {
  it('includes null-source rows and preserves block/tx/log pagination across old and new rows', async () => {
    const first = await store.listLaunches({ limit: 1, chainId: 4663 });
    expect(first.items[0].tokenAddress).toBe(tokens[0]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listLaunches({ limit: 1, chainId: 4663, cursor: first.nextCursor! });
    expect(second.items[0].tokenAddress).toBe(tokens[1]);
    const third = await store.listLaunches({ limit: 1, chainId: 4663, cursor: second.nextCursor! });
    expect(third.items[0].tokenAddress).toBe(tokens[2]);
  });
});

describe('safe head considers envio_chain_progress (final review, Important 3)', () => {
  const headToken = '0x1616161616161616161616161616161616161616';
  const headSource = 'envio-store-head-test';
  const headBlock = 99_999_999_999n;

  afterAll(async () => {
    await pool.query('DELETE FROM venues WHERE token_address = $1', [headToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [headToken]);
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[headSource, `${headSource}-trades`]]);
    await pool.query('DELETE FROM envio_chain_progress WHERE chain_id = 4663');
  });

  it('reports a launch as complete once envio_chain_progress reflects a head its source has reached, with no observed_blocks rows at all', async () => {
    // launchpad_test has no observed_blocks rows for chain 4663 (confirmed separately) — so with
    // envio_chain_progress also empty, safeHead must be null and coverage incomplete. Once
    // envio_chain_progress is set, safeHead must reflect it (GREATEST(NULL, headBlock) = headBlock).
    for (const id of [headSource, `${headSource}-trades`]) {
      await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
        VALUES ($1,4663,'v1',$2,0,0,$3,'caught_up') ON CONFLICT (id) DO UPDATE SET confirmed_to_block = $3, status = 'caught_up'`,
      [id, headToken, headBlock.toString()]);
    }
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,NULL,'HeadTest','HT',18,'pons','v1',$1,$1,1,$3,0,$1,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
    [headToken, headSource, '0x' + 'e'.repeat(64)]);
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,'v3_pool',$2,$3,NULL,1,true) ON CONFLICT (id) DO NOTHING`,
    [`4663:v3_pool:${headToken}`, headToken, headSource]);

    const beforeHead = await store.getLaunch(4663, headToken);
    expect(beforeHead?.coverageStatus).toBe('backfilling');

    await pool.query(`INSERT INTO envio_chain_progress (chain_id, head_block) VALUES (4663, $1)
      ON CONFLICT (chain_id) DO UPDATE SET head_block = $1`, [headBlock.toString()]);

    const afterHead = await store.getLaunch(4663, headToken);
    expect(afterHead?.coverageStatus).toBe('caught_up');
  });
});

describe('trade USD value (Important: must be null for an unknown quote asset, never 0)', () => {
  const usdToken = '0x1717171717171717171717171717171717171717';
  const usdSource = 'envio-store-usd-test';
  const venueId = `4663:curve:${usdToken}`;
  const txHash2 = '0x' + 'c'.repeat(64);

  async function seed(quoteAssetAddress: string, quoteAssetSymbol: string): Promise<void> {
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,4663,'v2',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [usdSource, usdToken]);
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,NULL,'UsdTest','UT',18,'pons','v2',$1,$1,1,$3,0,$5,$4,18,'trading') ON CONFLICT DO NOTHING`,
    [usdToken, usdSource, txHash2, quoteAssetSymbol, quoteAssetAddress]);
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,'curve',$2,$3,NULL,1,true) ON CONFLICT (id) DO NOTHING`,
    [venueId, usdToken, usdSource]);
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,1,$3,$4,0,1700000000,'buy','1000000000000000000','1000000000000000000',$1,'CurveBuy','user_trade',$1)
      ON CONFLICT DO NOTHING`,
    [usdToken, venueId, blockHash, txHash2]);
  }

  afterAll(async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM sources WHERE id = $1', [usdSource]);
  });

  it('returns null usdValue and usdValueApprox=false for a trade whose quote asset has no Chainlink feed', async () => {
    await seed(usdToken, 'SPCX'); // no real feed matches this placeholder address — exercises the no-feed path
    const readContract = vi.fn();
    const storeWithRpc = createApiStore(pool, { readContract });
    const trades = await storeWithRpc.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueApprox).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('computes an approximate usdValue for a trade whose quote asset has a known feed', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await seed(ETH_ADDRESS, 'ETH'); // real zero-address convention for native ETH — matches FEEDS
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 269170223591n, FRESH_FEED_UPDATED_AT, FRESH_FEED_UPDATED_AT, 1n];
      throw new Error(`unexpected ${functionName}`);
    });
    const storeWithRpc = createApiStore(pool, { readContract });
    const trades = await storeWithRpc.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValue).not.toBeNull();
    expect(Number(trades.items[0]!.usdValue)).toBeCloseTo(2691.70223591, 2);
    expect(trades.items[0]!.usdValueApprox).toBe(true);
  });

  it('keeps trades available with null USD values when the price feed RPC fails', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await seed(ETH_ADDRESS, 'ETH');
    __resetUsdPriceCacheForTests();
    const readContract = vi.fn().mockRejectedValue(new Error('RPC unavailable'));
    const storeWithRpc = createApiStore(pool, { readContract });
    const trades = await storeWithRpc.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items).toHaveLength(1);
    expect(trades.items[0]!.quoteAmount).toBe('1');
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueApprox).toBe(false);
    expect(readContract).toHaveBeenCalled();
  });

  it('returns null usdValue when no rpcClient was given to createApiStore at all', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await seed(ETH_ADDRESS, 'ETH');
    const trades = await store.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueApprox).toBe(false);
  });
});

describe('new stats fields degrade per-launch, not per-page (Review Focus)', () => {
  const goodToken = '0x1818181818181818181818181818181818181818';
  const brokenToken = '0x1919191919191919191919191919191919191919';
  const statsSource = 'envio-store-stats-test';
  const goodVenueId = `4663:v3_pool:${goodToken}`;

  beforeAll(async () => {
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,4663,'v1',$2,0,0,2000,'caught_up') ON CONFLICT DO NOTHING`, [statsSource, goodToken]);
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,4663,'v1',$2,0,0,2000,'caught_up') ON CONFLICT DO NOTHING`, [`${statsSource}-trades`, goodToken]);
    await pool.query(`INSERT INTO envio_chain_progress (chain_id, head_block) VALUES (4663, 2000)
      ON CONFLICT (chain_id) DO UPDATE SET head_block = 2000`);
    for (const [i, token] of [goodToken, brokenToken].entries()) {
      await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
        platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
        quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
        VALUES (4663,$1,$2,NULL,$3,'ST',18,'pons','v1',$1,$1,$4,$5,0,$6,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
      [token, statsSource, `Stats${i}`, (1000 + i).toString(), '0x' + String(i).repeat(64), ETH_ADDRESS]);
    }
    // The "good" launch needs a real priced trade so this test can prove it gets a genuine
    // non-null fdvUsd, not just that the broken sibling is null (final-review Important 8).
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,'v3_pool',$2,$3,NULL,1,true) ON CONFLICT (id) DO NOTHING`,
    [goodVenueId, goodToken, statsSource]);
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,price_numerator_raw,price_denominator_raw,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,1,$3,$4,0,$6,'buy','1000000000000000000','1000000000000000000',$5,'1','1','V3Swap','user_trade',$1)
      ON CONFLICT DO NOTHING`,
    [goodToken, goodVenueId, blockHash, '0x' + 'd'.repeat(64), ETH_ADDRESS, Math.floor(Date.now() / 1000) - 100]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [goodToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [goodToken]);
    await pool.query('DELETE FROM launches WHERE token_address = ANY($1)', [[goodToken, brokenToken]]);
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[statsSource, `${statsSource}-trades`]]);
    await pool.query('DELETE FROM envio_chain_progress WHERE chain_id = 4663');
  });

  function rpcClient() {
    return vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 269170223591n, FRESH_FEED_UPDATED_AT, FRESH_FEED_UPDATED_AT, 1n];
      if (functionName === 'totalSupply') {
        if (address.toLowerCase() === brokenToken.toLowerCase()) throw new Error('execution reverted');
        return 1_000_000n * 10n ** 18n;
      }
      throw new Error(`unexpected ${functionName}`);
    });
  }

  it('returns null stats for a launch whose totalSupply() reverts, while a sibling launch keeps its real name/symbol and gets a real fdvUsd', async () => {
    const readContract = rpcClient();
    const storeWithRpc = createApiStore(pool, { readContract });
    const page = await storeWithRpc.listLaunches({ limit: 50, chainId: 4663 });
    const good = page.items.find((item) => item.tokenAddress === goodToken);
    const broken = page.items.find((item) => item.tokenAddress === brokenToken);
    expect(good).toBeDefined();
    expect(broken).toBeDefined();
    expect(broken!.fdvUsd).toBeNull();
    expect(broken!.marketCapUsd).toBeNull();
    expect(good!.name).toBe('Stats0');
    expect(broken!.name).toBe('Stats1');
    expect(good!.fdvUsd).not.toBeNull();
    expect(Number(good!.fdvUsd)).toBeCloseTo(1_000_000 * 2691.70223591, 0);
    expect(good!.marketCapUsd).toBe(good!.fdvUsd);
    expect(good!.week52High).toBe('1');
    expect(good!.week52Low).toBe('1');
  });

  it('getLaunch also returns real stats for a single launch (final-review Important 8)', async () => {
    const readContract = rpcClient();
    const storeWithRpc = createApiStore(pool, { readContract });
    const detail = await storeWithRpc.getLaunch(4663, goodToken);
    expect(detail).not.toBeNull();
    expect(detail!.fdvUsd).not.toBeNull();
    expect(Number(detail!.fdvUsd)).toBeCloseTo(1_000_000 * 2691.70223591, 0);
    expect(detail!.marketCapUsd).toBe(detail!.fdvUsd);
    expect(detail!.week52High).toBe('1');
    expect(detail!.week52Low).toBe('1');
  });

  it('withholds FDV and 52-week extrema while the launch trade source is backfilling', async () => {
    await pool.query('UPDATE sources SET status = $1, confirmed_to_block = 0 WHERE id = $2', ['backfilling', `${statsSource}-trades`]);
    try {
      const storeWithRpc = createApiStore(pool, { readContract: rpcClient() });
      const detail = await storeWithRpc.getLaunch(4663, goodToken);
      expect(detail?.coverageStatus).toBe('backfilling');
      expect(detail?.priceQuote).toBeNull();
      expect(detail?.fdvUsd).toBeNull();
      expect(detail?.marketCapUsd).toBeNull();
      expect(detail?.week52High).toBeNull();
      expect(detail?.week52Low).toBeNull();
    } finally {
      await pool.query('UPDATE sources SET status = $1, confirmed_to_block = 2000 WHERE id = $2', ['caught_up', `${statsSource}-trades`]);
    }
  });

  it('withholds USD valuations for an unknown quote address even if its symbol says ETH', async () => {
    await pool.query('UPDATE launches SET quote_asset_address = $1 WHERE token_address = $2', [goodToken, goodToken]);
    try {
      const storeWithRpc = createApiStore(pool, { readContract: rpcClient() });
      const detail = await storeWithRpc.getLaunch(4663, goodToken);
      expect(detail?.coverageStatus).toBe('caught_up');
      expect(detail?.fdvUsd).toBeNull();
      expect(detail?.marketCapUsd).toBeNull();
    } finally {
      await pool.query('UPDATE launches SET quote_asset_address = $1 WHERE token_address = $2', [ETH_ADDRESS, goodToken]);
    }
  });

  it('shows curve TVL from current real USDG reserve even while historical coverage is incomplete', async () => {
    const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const curve = '0xf17871c268122408f677073066bb36fecddc1ba0';
    await pool.query(`UPDATE launches SET protocol_version='v2', quote_asset_address=$1,
      quote_asset_symbol='USDG', quote_asset_decimals=6 WHERE token_address=$2`, [usdg, goodToken]);
    await pool.query("UPDATE venues SET kind='curve',ref=$1 WHERE id=$2", [curve, goodVenueId]);
    await pool.query("UPDATE sources SET status='backfilling',confirmed_to_block=0 WHERE id=$1", [statsSource]);
    try {
      const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') {
          const now = BigInt(Math.floor(Date.now() / 1000));
          return [1n, 100_000_000n, now, now, 1n];
        }
        if (functionName === 'getLaunchedToken') return { exists: true, phase: 0, token: goodToken, curve };
        if (functionName === 'realQuoteReserve') return 15_700_717n;
        if (functionName === 'totalSupply') return 1_000_000n * 10n ** 18n;
        throw new Error(functionName);
      });
      const storeWithRpc = createApiStore(pool, { readContract, getBlockNumber: async () => 77_455_470n });
      const detail = await storeWithRpc.getLaunch(4663, goodToken);
      expect(detail?.coverageStatus).toBe('backfilling');
      expect(detail?.tvlUsd).toBe('15.700717');
      expect(detail?.tvlBasis).toBe('curve_real_quote');
      expect(detail?.tvlPriceSource).toBe('chainlink');
    } finally {
      await pool.query(`UPDATE launches SET protocol_version='v1',quote_asset_address=$1,
        quote_asset_symbol='ETH',quote_asset_decimals=18 WHERE token_address=$2`, [ETH_ADDRESS, goodToken]);
      await pool.query("UPDATE venues SET kind='v3_pool',ref=$1 WHERE id=$2", [goodToken, goodVenueId]);
      await pool.query("UPDATE sources SET status='caught_up',confirmed_to_block=2000 WHERE id=$1", [statsSource]);
    }
  });
});
