import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { upsertQuoteFeed } from '../market/quotePricing/feedRegistry.js';
import { upsertPriceRounds } from '../market/quotePricing/priceRounds.js';
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

  it('filters by platform — a real (if currently one-option) filter per the spec\'s confirmed decision', async () => {
    await pool.query('UPDATE launches SET platform = $1 WHERE token_address = $2', ['other-launchpad', tokens[1]]);
    try {
      const ponsOnly = await store.listLaunches({ limit: 10, chainId: 4663, platform: 'pons' });
      expect(ponsOnly.items.map((item) => item.tokenAddress)).not.toContain(tokens[1]);
      expect(ponsOnly.items.map((item) => item.tokenAddress)).toContain(tokens[0]);

      const otherOnly = await store.listLaunches({ limit: 10, chainId: 4663, platform: 'other-launchpad' });
      expect(otherOnly.items.map((item) => item.tokenAddress)).toEqual([tokens[1]]);
    } finally {
      await pool.query('UPDATE launches SET platform = $1 WHERE token_address = $2', ['pons', tokens[1]]);
    }
  });
});

describe('a near-realtime-synced launch with unresolved core metadata', () => {
  const pendingToken = '0x1717171717171717171717171717171717171717';
  const pendingSource = 'envio-store-pending-metadata-test';

  beforeAll(async () => {
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,4663,'v1',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [pendingSource, pendingToken]);
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status,core_metadata_read_state)
      VALUES (4663,$1,$2,NULL,NULL,NULL,NULL,'pons','v1',$1,$1,1,$3,9,$1,NULL,NULL,'trading','pending') ON CONFLICT DO NOTHING`,
    [pendingToken, pendingSource, `0x${'9'.repeat(64)}`]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM launches WHERE token_address = $1', [pendingToken]);
    await pool.query('DELETE FROM sources WHERE id = $1', [pendingSource]);
  });

  it('serves name/symbol/quoteAsset as null and degrades FDV/TVL to null instead of crashing', async () => {
    const detail = await store.getLaunch(4663, pendingToken);
    expect(detail).not.toBeNull();
    expect(detail!.name).toBeNull();
    expect(detail!.symbol).toBeNull();
    expect(detail!.quoteAsset.symbol).toBeNull();
    expect(detail!.quoteAsset.decimals).toBeNull();
    expect(detail!.fdvUsd).toBeNull();
    expect(detail!.tvlUsd).toBeNull();

    const list = await store.listLaunches({ limit: 50, chainId: 4663 });
    const item = list.items.find((row) => row.tokenAddress === pendingToken);
    expect(item?.name).toBeNull();
    expect(item?.symbol).toBeNull();
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
  const historicalFeed: `0x${string}` = `0x${'f'.repeat(40)}`;

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
    await pool.query('DELETE FROM price_jobs WHERE chain_id = 4663 AND feed_address = $1', [historicalFeed]);
    await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = 4663 AND feed_address = $1', [historicalFeed]);
    await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = $1', [ETH_ADDRESS]);
  });

  it('returns null usdValue and usdValueApprox=false for a trade whose quote asset has no Chainlink feed', async () => {
    await seed(usdToken, 'SPCX'); // no real feed matches this placeholder address — exercises the no-feed path
    const readContract = vi.fn();
    const storeWithRpc = createApiStore(pool, { readContract });
    const trades = await storeWithRpc.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueApprox).toBe(false);
    expect(trades.items[0]!.usdValueStatus).toBe('unavailable');
    expect(readContract).not.toHaveBeenCalled();
  });

  it('values a trade at its own historical quote price, never the current/latest price, and never changes when the latest price moves', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = 4663 AND feed_address = $1', [historicalFeed]);
    await seed(ETH_ADDRESS, 'ETH'); // real zero-address convention for native ETH; trade sits at (block_number=1, log_index=0), timestamp=1700000000
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: ETH_ADDRESS as `0x${string}`, feedAddress: historicalFeed,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
    await upsertPriceRounds(pool, 4663, historicalFeed, [
      // A decoy round at an EARLIER chain position with a wildly different price — proves position,
      // not recency of insertion or "the latest round", drives selection.
      { roundId: 1n, answerRaw: 999999999999n, decimals: 8, startedAt: 1_600_000_000, updatedAt: 1_600_000_000, blockNumber: 0n, logIndex: 0 },
      // The round at-or-before the trade's own (blockNumber, logIndex) — this is the one that must win.
      { roundId: 2n, answerRaw: 269170223591n, decimals: 8, startedAt: 1_699_999_000, updatedAt: 1_699_999_000, blockNumber: 1n, logIndex: 0 },
    ]);

    const trades = await store.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValueStatus).toBe('priced');
    expect(Number(trades.items[0]!.usdValue)).toBeCloseTo(2691.70223591, 2);
    expect(trades.items[0]!.usdValueApprox).toBe(true);
  });

  it('returns usdValueStatus: pending (not a silently-approximated value) and enqueues a round-backfill job when the historical round is missing', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = 4663 AND feed_address = $1', [historicalFeed]);
    await pool.query(`DELETE FROM price_jobs WHERE chain_id = 4663 AND job_type = 'round_backfill' AND feed_address = $1`, [historicalFeed]);
    await seed(ETH_ADDRESS, 'ETH');
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: ETH_ADDRESS as `0x${string}`, feedAddress: historicalFeed,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
    // No rounds at all — the feed is verified but has no backfilled history yet.

    const trades = await store.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueStatus).toBe('pending');

    const jobs = await pool.query(`SELECT range_start, range_end FROM price_jobs
      WHERE chain_id = 4663 AND job_type = 'round_backfill' AND feed_address = $1`, [historicalFeed]);
    expect(jobs.rows.length).toBeGreaterThan(0);
    expect(jobs.rows.some((row) => Number(row.range_start) <= 1_700_000_000 && Number(row.range_end) >= 1_700_000_000)).toBe(true);
  });

  it('coalesces every pending row on one page into a single round-backfill job per feed, not one job per row', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = 4663 AND feed_address = $1', [historicalFeed]);
    await pool.query(`DELETE FROM price_jobs WHERE chain_id = 4663 AND job_type = 'round_backfill' AND feed_address = $1`, [historicalFeed]);
    await seed(ETH_ADDRESS, 'ETH'); // seeds one trade at timestamp 1,700,000,000
    // A second trade, far enough from the first that one ±3600s job per row would need two jobs —
    // coalescing into [min-3600, max+3600] must still produce exactly one.
    const farApartTimestamp = 1_700_100_000;
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,2,$3,$4,0,$5,'buy','1','1',$1,'CurveBuy','user_trade',$1) ON CONFLICT DO NOTHING`,
    [usdToken, venueId, blockHash, '0x' + 'c2'.repeat(32), farApartTimestamp]);
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: ETH_ADDRESS as `0x${string}`, feedAddress: historicalFeed,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });

    const trades = await store.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items.every((item) => item.usdValueStatus === 'pending')).toBe(true);

    const jobs = await pool.query(`SELECT range_start, range_end FROM price_jobs
      WHERE chain_id = 4663 AND job_type = 'round_backfill' AND feed_address = $1`, [historicalFeed]);
    expect(jobs.rows).toHaveLength(1);
    expect(Number(jobs.rows[0].range_start)).toBeLessThanOrEqual(1_700_000_000 - 3600);
    expect(Number(jobs.rows[0].range_end)).toBeGreaterThanOrEqual(farApartTimestamp + 3600);
  });

  it('returns usdValueStatus: unavailable when there is no verified feed for the quote asset at all, and enqueues no round-backfill job', async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [usdToken]);
    await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = $1', [usdToken]);
    const before = await pool.query(`SELECT count(*)::int AS count FROM price_jobs WHERE job_type = 'round_backfill'`);
    await seed(usdToken, 'SPCX'); // same placeholder-address convention as the no-feed test above — a feed_resolution
    // job may already exist for this address from the Task 6 sync-path hook; that's fine and expected.

    const trades = await store.listTrades(4663, usdToken, { limit: 10 });
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueStatus).toBe('unavailable');

    const after = await pool.query(`SELECT count(*)::int AS count FROM price_jobs WHERE job_type = 'round_backfill'`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});

describe('new stats fields degrade per-launch, not per-page (Review Focus)', () => {
  const goodToken = '0x1818181818181818181818181818181818181818';
  const brokenToken = '0x1919191919191919191919191919191919191919';
  const statsSource = 'envio-store-stats-test';
  const goodVenueId = `4663:v3_pool:${goodToken}`;
  const statsEthFeed = '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9';

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
    // Self-contained, not reliant on another test file's quote_usd_feeds seed — readUsdPrice
    // resolves through the persisted registry now, not a hardcoded map.
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: ETH_ADDRESS as `0x${string}`, feedAddress: statsEthFeed,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
  });
  afterAll(async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [goodToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [goodToken]);
    await pool.query('DELETE FROM launches WHERE token_address = ANY($1)', [[goodToken, brokenToken]]);
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[statsSource, `${statsSource}-trades`]]);
    await pool.query('DELETE FROM envio_chain_progress WHERE chain_id = 4663');
    await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = $1', [ETH_ADDRESS]);
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

  it('computes 52-week high/low and 1h/1d change from one formatting pass (no duplicate formatRational work)', async () => {
    // Regression guard for the dedup refactor (be/src/api/store.ts's computeStats): two extra
    // trades at distinct prices and ages give week52High/Low and change1h/change1d each a distinct,
    // independently-verifiable expected value computed from the SAME three trades — a formatting
    // bug that duplicated or dropped a row would show up as a wrong number here, not just a defined one.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const pastHourTxHash = '0x' + 'e1'.repeat(32);
    const pastDayTxHash = '0x' + 'e2'.repeat(32);
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,price_numerator_raw,price_denominator_raw,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,2,$3,$4,0,$6,'buy','1000000000000000000','2000000000000000000',$5,'2','1','V3Swap','user_trade',$1)
      ON CONFLICT DO NOTHING`,
    [goodToken, goodVenueId, blockHash, pastHourTxHash, ETH_ADDRESS, nowSeconds - 7_200]);
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,price_numerator_raw,price_denominator_raw,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,3,$3,$4,0,$6,'buy','1000000000000000000','4000000000000000000',$5,'4','1','V3Swap','user_trade',$1)
      ON CONFLICT DO NOTHING`,
    [goodToken, goodVenueId, blockHash, pastDayTxHash, ETH_ADDRESS, nowSeconds - 90_000]);
    try {
      const storeWithRpc = createApiStore(pool, { readContract: rpcClient() });
      const detail = await storeWithRpc.getLaunch(4663, goodToken);
      // Three priced trades for goodToken: price 1 (~100s ago, from beforeAll), price 2 (2h ago),
      // price 4 (25h ago) — so high=4, low=1.
      expect(detail?.week52High).toBe('4');
      expect(detail?.week52Low).toBe('1');
      // change1h: latest price at/before now is 1 (the ~100s-ago trade); latest at/before now-3600 is
      // 2 (the 2h-ago trade, the only one old enough) -> (1-2)/2*100 = -50.
      expect(detail?.change1h).toBe('-50');
      // change1d: latest at/before now-86400 is 4 (the 25h-ago trade, the only one old enough) ->
      // (1-4)/4*100 = -75.
      expect(detail?.change1d).toBe('-75');
    } finally {
      await pool.query('DELETE FROM trades WHERE tx_hash = ANY($1)', [[pastHourTxHash, pastDayTxHash]]);
    }
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
    const usdgFeed = '0x61b7e5650328764b076a108eff5fa7282a1b9ad2';
    const curve = '0xf17871c268122408f677073066bb36fecddc1ba0';
    await pool.query(`UPDATE launches SET protocol_version='v2', quote_asset_address=$1,
      quote_asset_symbol='USDG', quote_asset_decimals=6 WHERE token_address=$2`, [usdg, goodToken]);
    await pool.query("UPDATE venues SET kind='curve',ref=$1 WHERE id=$2", [curve, goodVenueId]);
    await pool.query("UPDATE sources SET status='backfilling',confirmed_to_block=0 WHERE id=$1", [statsSource]);
    // This test is self-contained, not reliant on any other test file's quote_usd_feeds seed —
    // readUsdPrice resolves through the persisted registry now, not a hardcoded map.
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: usdg as `0x${string}`, feedAddress: usdgFeed as `0x${string}`,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
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
      await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = $1', [usdg]);
    }
  });

  it('returns real logo/description/website/twitter/launchTimestamp from the launches row, with no RPC call', async () => {
    await pool.query(`UPDATE launches SET logo_uri=$1, description=$2, website_url=$3, twitter_url=$4, launch_timestamp=$5 WHERE token_address=$6`,
      ['ipfs://bafkreitest', 'A real token', 'https://example.com', 'https://x.com/example', 1_700_000_000, goodToken]);
    try {
      const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') return [1n, 269170223591n, FRESH_FEED_UPDATED_AT, FRESH_FEED_UPDATED_AT, 1n];
        if (functionName === 'totalSupply') return 1_000_000n * 10n ** 18n;
        throw new Error(`unexpected ${functionName}`);
      });
      const storeWithRpc = createApiStore(pool, { readContract });
      const detail = await storeWithRpc.getLaunch(4663, goodToken);
      expect(detail?.logoUri).toBe('ipfs://bafkreitest');
      expect(detail?.description).toBe('A real token');
      expect(detail?.websiteUrl).toBe('https://example.com');
      expect(detail?.twitterUrl).toBe('https://x.com/example');
      expect(detail?.launchTimestamp).toBe('1700000000');
    } finally {
      await pool.query(`UPDATE launches SET logo_uri=NULL, description=NULL, website_url=NULL, twitter_url=NULL, launch_timestamp=NULL WHERE token_address=$1`, [goodToken]);
    }
  });

  it('omits description from list items but keeps it on launch detail', async () => {
    await pool.query(`UPDATE launches SET description = $1 WHERE token_address = $2`, ['List vs detail description', goodToken]);
    try {
      const list = await store.listLaunches({ limit: 50, chainId: 4663 });
      const item = list.items.find((i) => i.tokenAddress === goodToken);
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty('description');
      const detail = await store.getLaunch(4663, goodToken);
      expect(detail?.description).toBe('List vs detail description');
    } finally {
      await pool.query(`UPDATE launches SET description = NULL WHERE token_address = $1`, [goodToken]);
    }
  });

  it('returns null extended-metadata fields for a launch that never had them indexed', async () => {
    const storeWithRpc = createApiStore(pool, { readContract: vi.fn() });
    const detail = await storeWithRpc.getLaunch(4663, goodToken);
    expect(detail?.logoUri).toBeNull();
    expect(detail?.description).toBeNull();
    expect(detail?.websiteUrl).toBeNull();
    expect(detail?.twitterUrl).toBeNull();
    expect(detail?.launchTimestamp).toBeNull();
  });

  it('picks the chronologically-latest trade by (blockNumber, logIndex) as "current" when two trades share a timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,price_numerator_raw,price_denominator_raw,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,0,$3,$4,0,$5,'buy','1','1',$6,'1','1','V3Swap','user_trade',$1)`,
    [goodToken, goodVenueId, blockHash, '0x' + 'e'.repeat(64), now - 7200, ETH_ADDRESS]);
    // Two trades at the SAME second but different (blockNumber, logIndex) — the one with the
    // higher pair must win as "current", regardless of the order Postgres happens to return rows
    // in (final-review Important 2).
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,price_numerator_raw,price_denominator_raw,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,11,$3,$4,0,$5,'buy','1','1',$6,'4','1','V3Swap','user_trade',$1),
             (4663,$1,$2,10,$3,$7,0,$5,'buy','1','1',$6,'2','1','V3Swap','user_trade',$1)`,
    [goodToken, goodVenueId, blockHash, '0x' + 'f'.repeat(64), now - 10, ETH_ADDRESS, '0x' + '1'.repeat(64)]);
    try {
      const storeWithRpc = createApiStore(pool, { readContract: vi.fn() });
      const detail = await storeWithRpc.getLaunch(4663, goodToken);
      // (4 - 1) / 1 * 100 = 300 — using block 11's price (4), never block 10's price (2), as "current".
      expect(detail?.change1h).toBe('300');
    } finally {
      await pool.query(`DELETE FROM trades WHERE token_address = $1 AND block_number IN (0, 10, 11)`, [goodToken]);
    }
  });

  it('computes a real change1h/change1d from official trades, and null for a launch with none', async () => {
    const storeWithRpc = createApiStore(pool, { readContract: vi.fn() });
    const detail = await storeWithRpc.getLaunch(4663, goodToken);
    // goodToken's beforeAll fixture seeds exactly one trade "now" — one trade alone can't
    // produce a non-null change1h/1d (no trade exists one window further back).
    expect(detail?.change1h).toBeNull();
    expect(detail?.change1d).toBeNull();
  });
});

describe('listLaunches sort=volume24hUsd (global ranking)', () => {
  const rankSource = 'volume-rank-test-source';
  const rankQuote = '0xranka000000000000000000000000000000001';
  const rankFeed = '0xrankfeed00000000000000000000000000f002';
  const launchA = '0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0'; // $300
  const launchB = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'; // $100
  const launchC = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0'; // zero trades, complete -> "0"
  const launchD = '0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0'; // one trade, no round at its position -> null
  const rankBlockHash = '0x' + '9'.repeat(64);
  let rankNow: number;

  beforeAll(async () => {
    rankNow = Math.floor(Date.now() / 1000);
    for (const id of [rankSource, `${rankSource}-trades`]) {
      await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
        VALUES ($1,4663,'v1',$2,0,0,2000,'caught_up') ON CONFLICT DO NOTHING`, [id, launchA]);
    }
    await pool.query(`INSERT INTO envio_chain_progress (chain_id, head_block) VALUES (4663, 2000)
      ON CONFLICT (chain_id) DO UPDATE SET head_block = 2000`);
    for (const [i, token] of [launchA, launchB, launchC, launchD].entries()) {
      await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,name,symbol,token_decimals,
        platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
        quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
        VALUES (4663,$1,$2,$3,$3,18,'pons','v1',$1,$1,$4,$5,0,$6,'RANK',18,'trading') ON CONFLICT DO NOTHING`,
      [token, rankSource, ['A', 'B', 'C', 'D'][i], (2000 + i).toString(), '0x' + `r${i}`.repeat(32), rankQuote]);
      const venueId = `4663:v3_pool:${token}`;
      await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,effective_from_block,official)
        VALUES ($1,4663,$2,'v3_pool',$2,$3,1,true) ON CONFLICT (id) DO NOTHING`, [venueId, token, rankSource]);
    }
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: rankQuote, feedAddress: rankFeed,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
    await upsertPriceRounds(pool, 4663, rankFeed, [
      { roundId: 1n, answerRaw: 100_000_000n, decimals: 8, startedAt: rankNow - 200, updatedAt: rankNow - 200, blockNumber: 1000n, logIndex: 0 },
    ]);
    // A: one trade, 300 quote units @ $1 = $300. Block 1001 (after the round) so it's priced.
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,1001,$3,$4,0,$5,'buy','1','300000000000000000000',$6,'V3Swap','user_trade',$1)`,
    [launchA, `4663:v3_pool:${launchA}`, rankBlockHash, '0x' + 'ea'.repeat(32), rankNow - 100, rankQuote]);
    // B: one trade, 100 quote units @ $1 = $100.
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,1001,$3,$4,0,$5,'buy','1','100000000000000000000',$6,'V3Swap','user_trade',$1)`,
    [launchB, `4663:v3_pool:${launchB}`, rankBlockHash, '0x' + 'eb'.repeat(32), rankNow - 100, rankQuote]);
    // D: one trade, but at block 500 — BEFORE the round (block 1000), so findRoundAtOrBefore finds nothing.
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,500,$3,$4,0,$5,'buy','1','50000000000000000000',$6,'V3Swap','user_trade',$1)`,
    [launchD, `4663:v3_pool:${launchD}`, rankBlockHash, '0x' + 'ed'.repeat(32), rankNow - 100, rankQuote]);
  });

  afterAll(async () => {
    for (const token of [launchA, launchB, launchC, launchD]) {
      await pool.query('DELETE FROM trades WHERE token_address = $1', [token]);
      await pool.query('DELETE FROM venues WHERE token_address = $1', [token]);
      await pool.query('DELETE FROM launches WHERE token_address = $1', [token]);
    }
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[rankSource, `${rankSource}-trades`]]);
    await pool.query('DELETE FROM quote_usd_feeds WHERE quote_asset_address = $1', [rankQuote]);
    await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [rankFeed]);
    await pool.query('DELETE FROM envio_chain_progress WHERE chain_id = 4663');
  });

  it('ranks launches by real USD volume descending, not by raw quote-unit amounts across different quote assets', async () => {
    const page = await store.listLaunches({ limit: 50, chainId: 4663, sort: 'volume24hUsd' });
    const ranked = page.items.filter((item) => [launchA, launchB, launchC, launchD].includes(item.tokenAddress));
    expect(ranked.map((item) => item.tokenAddress)).toEqual([launchA, launchB, launchC, launchD]);
  });

  it('gives a known zero-trade launch with complete coverage a real "0", never null', async () => {
    const page = await store.listLaunches({ limit: 50, chainId: 4663, sort: 'volume24hUsd' });
    const zero = page.items.find((item) => item.tokenAddress === launchC);
    expect(zero?.officialVolume24hUsd).toBe('0');
    expect(zero?.officialVolume24hUsdApprox).toBe(false);
  });

  it('gives a launch with a positive trade but a missing historical round a null rank, never an understated partial sum', async () => {
    const page = await store.listLaunches({ limit: 50, chainId: 4663, sort: 'volume24hUsd' });
    const partial = page.items.find((item) => item.tokenAddress === launchD);
    expect(partial?.officialVolume24hUsd).toBeNull();
  });

  it('computes the correct real USD totals for the positive-volume launches', async () => {
    const page = await store.listLaunches({ limit: 50, chainId: 4663, sort: 'volume24hUsd' });
    expect(page.items.find((item) => item.tokenAddress === launchA)?.officialVolume24hUsd).toBe('300');
    expect(page.items.find((item) => item.tokenAddress === launchB)?.officialVolume24hUsd).toBe('100');
  });

  it('paginates with a signed cursor distinct from the recency cursor, and rejects a cursor used with the wrong sort', async () => {
    const first = await store.listLaunches({ limit: 1, chainId: 4663, sort: 'volume24hUsd' });
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listLaunches({ limit: 1, chainId: 4663, sort: 'volume24hUsd', cursor: first.nextCursor! });
    expect(second.items[0]?.tokenAddress).not.toBe(first.items[0]?.tokenAddress);
    await expect(store.listLaunches({ limit: 1, chainId: 4663, sort: 'recent', cursor: first.nextCursor! })).rejects.toThrow();
  });

  it('keeps sort=recent (default) unaffected by the new ranking fields', async () => {
    const page = await store.listLaunches({ limit: 50, chainId: 4663 });
    const a = page.items.find((item) => item.tokenAddress === launchA);
    expect(a?.officialVolume24hUsd).toBeNull();
    expect(a?.officialVolume24hUsdApprox).toBe(false);
  });
});
