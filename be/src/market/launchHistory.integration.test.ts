import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readLaunchHistory } from './launchHistory.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'launch-history-test-src';
const token = `0x${'d5'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const feed = `0x${'d6'.repeat(20)}`;
const venueId = 'launch-history-test-venue';
const base = 1_800_000_000; // divisible by 60, so buckets start on the minute
const e18 = 10n ** 18n;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'d7'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'USD candle', 'USC', 18, 'pons', 'v2', $2, $2, 100, $4, 0, $5, 'ETH', 18, 'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'d8'.repeat(32)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'curve', $3, $4, 1, true) ON CONFLICT DO NOTHING`, [venueId, chainId, token, source]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'test', 'verified', now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  // ETH = $2.00 (answer 200000000 with 8 decimals), updated 100 seconds before the first trade.
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1, $2, 1, 200000000, 8, $3, $3, 500, 0) ON CONFLICT DO NOTHING`, [chainId, feed, base - 100]);
  const trade = async (block: number, log: number, ts: number, tokens: bigint, quoteEth: bigint) => {
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'buy', $9, $10, $11, 'Swap', 'user_trade', $2)`,
    [chainId, token, venueId, block, `0x${String(block).padStart(64, '0')}`, `0x${String(block * 10 + log).padStart(64, '0')}`, log, ts,
      (tokens * e18).toString(), (quoteEth * e18).toString(), quote]);
  };
  await trade(600, 1, base + 5, 1n, 1n);   // minute 1: price 2.00 USD per token
  await trade(601, 1, base + 20, 1n, 2n);  // minute 1: price 4.00 USD per token
  await trade(602, 1, base + 70, 2n, 1n);  // minute 2: price 1.00 USD per token
  await trade(300, 1, base + 130, 1n, 1n); // before the round's block: unpriced, so its minute is omitted
});

afterAll(async () => {
    await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM venues WHERE id = $1', [venueId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, quote]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('readLaunchHistory', () => {
  it('sums official USD volume per bucket, marks a bucket with an unpriced trade unavailable, and a quiet bucket a real zero only when complete', async () => {
    const options = { chainId, tokenAddress: token, intervalSeconds: 60, buckets: 4, asOf: base + 190 };
    const complete = await readLaunchHistory(pool, { ...options, complete: true });
    expect(complete.items).toEqual([
      { day: base, tradeCount: 2, volumeUsd: '6', tvlUsd: null },
      { day: base + 60, tradeCount: 1, volumeUsd: '2', tvlUsd: null },
      { day: base + 120, tradeCount: 1, volumeUsd: null, tvlUsd: null },
      { day: base + 180, tradeCount: 0, volumeUsd: '0', tvlUsd: null },
    ]);
    const incomplete = await readLaunchHistory(pool, { ...options, complete: false });
    expect(incomplete.items.at(-1)).toMatchObject({ day: base + 180, volumeUsd: null });
  });

  it('rejects an unsupported interval or bucket count', async () => {
    await expect(readLaunchHistory(pool, { chainId, tokenAddress: token, intervalSeconds: 7, buckets: 3, asOf: 1, complete: true })).rejects.toThrow('Invalid launch history window');
    await expect(readLaunchHistory(pool, { chainId, tokenAddress: token, intervalSeconds: 60, buckets: 201, asOf: 1, complete: true })).rejects.toThrow('Invalid launch history window');
  });
});

describe('readLaunchHistory venueKind scoping', () => {
  const v4VenueId = 'launch-history-test-v4-venue';
  const options = { chainId, tokenAddress: token, intervalSeconds: 60, buckets: 2, asOf: base + 70, complete: true };

  async function addV4Trade() {
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1, $2, $3, 'v4_pool', $4, $5, 2, true) ON CONFLICT DO NOTHING`, [v4VenueId, chainId, token, `0x${'d9'.repeat(32)}`, source]);
    // 3 ETH of volume in the first minute, on the V4 venue ($6 at $2/ETH).
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1, $2, $3, 700, $4, $5, 1, $6, 'buy', $7, $8, $9, 'Swap', 'user_trade', $2)`,
    [chainId, token, v4VenueId, `0x${'70'.repeat(32)}`, `0x${'71'.repeat(32)}`, base + 10, e18.toString(), (3n * e18).toString(), quote]);
  }
  afterEach(async () => {
    await pool.query('DELETE FROM trades WHERE venue_id = $1', [v4VenueId]);
    await pool.query('DELETE FROM venues WHERE id = $1', [v4VenueId]);
  });

  it('counts every official venue unscoped, and only the requested venue kind (with no TVL series) when scoped', async () => {
    await addV4Trade();
    const all = await readLaunchHistory(pool, options);
    expect(all.items[0]).toMatchObject({ day: base, tradeCount: 3, volumeUsd: '12' });
    const curveOnly = await readLaunchHistory(pool, { ...options, venueKind: 'curve' });
    expect(curveOnly.items[0]).toEqual({ day: base, tradeCount: 2, volumeUsd: '6', tvlUsd: null });
  });
});
