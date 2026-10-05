import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculateLaunchVolume } from './calculate.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'calc-test-src';
const sourceTrades = `${source}-trades`;
const windowEnd = 1_800_000_000;
const completeHead = 4_000n;
const incompleteHead = 6_000n;
const tokens: string[] = [];
const quotes: string[] = [];
const feeds: string[] = [];
let counter = 0;

interface Fixture { token: string; quote: string; feed: string; venueId: string; officialVenueId: string | null }

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v1', $3, 0, 5000, 5000, 'caught_up'), ($4, $2, 'v1', $3, 0, 5000, 5000, 'caught_up')
    ON CONFLICT (id) DO UPDATE SET confirmed_to_block = 5000, scanned_to_block = 5000, status = 'caught_up'`,
  [source, chainId, `0x${'a0'.repeat(20)}`, sourceTrades]);
});

afterAll(async () => {
  for (const token of tokens) {
    await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    await pool.query('DELETE FROM venues WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  }
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = ANY($2)', [chainId, feeds]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = ANY($2)', [chainId, quotes]);
  await pool.end();
});

// Each test gets its own token, quote asset, and feed so price rounds and feed mappings never leak between tests.
async function setupLaunch(): Promise<Fixture> {
  counter += 1;
  const token = `0x${hex(0x500000 + counter, 40)}`;
  const quote = `0x${hex(0x600000 + counter, 40)}`;
  const feed = `0x${hex(0x700000 + counter, 40)}`;
  tokens.push(token);
  quotes.push(quote);
  feeds.push(feed);
  const venueId = `calc-venue-${counter}`;
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'Calc', 'CLC', 18, 'pons', 'v1', $2, $2, 100, $4, 1, $5, 'WETH', 18, 'trading')`,
  [chainId, token, source, `0x${hex(counter, 64)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'v3_pool', $3, $4, 1, true)`, [venueId, chainId, token, source]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'test', 'verified', now())`, [chainId, quote, feed]);
  return { token, quote, feed, venueId, officialVenueId: null };
}

async function addRound(fixture: Fixture, roundId: number, blockNumber: number, answerRaw: bigint, updatedAt: number): Promise<void> {
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1, $2, $3, $4, 8, $5, $5, $6, 0)`, [chainId, fixture.feed, roundId, answerRaw.toString(), updatedAt, blockNumber]);
}

async function addTrade(fixture: Fixture, venueId: string, blockNumber: number, timestamp: number, quoteAmountRaw: bigint, tag: number): Promise<void> {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'buy', '1', $8, $9, 'Swap', 'user_trade', $2)`,
  [chainId, fixture.token, venueId, blockNumber, `0x${hex(tag, 64)}`, `0x${hex(tag + 1, 64)}`, timestamp,
    quoteAmountRaw.toString(), fixture.quote]);
}

const key = (token: string) => ({ chainId, tokenAddress: token });
const twoEth = 2_000_000_000_000_000_000n;
// 2 quote tokens at a 1.5 USD price (answer 150000000, 8 decimals) is exactly 3 USD.
const onePointFive = 150_000_000n;

describe('calculateLaunchVolume', () => {
  it('values an official trade with the verified round at or before its own position', async () => {
    const fixture = await setupLaunch();
    await addRound(fixture, 1, 500, onePointFive, windowEnd - 200);
    await addRound(fixture, 2, 700, 900_000_000n, windowEnd - 50);
    await addTrade(fixture, fixture.venueId, 600, windowEnd - 100, twoEth, 1_000_001);

    const score = await calculateLaunchVolume(pool, key(fixture.token), windowEnd, completeHead);

    expect(score).toMatchObject({ volumeUsd: '3', rankCategory: 'positive', completenessReason: 'complete', windowEnd });
    expect(score.nextExpiryAt?.getTime()).toBe((windowEnd - 100 + 86_401) * 1000);
  });

  it('returns null when a positive trade has no verified round at or before its position', async () => {
    const fixture = await setupLaunch();
    await addRound(fixture, 1, 700, onePointFive, windowEnd - 50);
    await addTrade(fixture, fixture.venueId, 600, windowEnd - 100, twoEth, 1_000_011);

    const score = await calculateLaunchVolume(pool, key(fixture.token), windowEnd, completeHead);

    expect(score).toMatchObject({ volumeUsd: null, rankCategory: 'null', completenessReason: 'unpriced_trade' });
  });

  it('returns null when the only round before the trade is older than 24 hours', async () => {
    const fixture = await setupLaunch();
    await addRound(fixture, 1, 500, onePointFive, windowEnd - 100 - 86_401);
    await addTrade(fixture, fixture.venueId, 600, windowEnd - 100, twoEth, 1_000_021);

    const score = await calculateLaunchVolume(pool, key(fixture.token), windowEnd, completeHead);

    expect(score).toMatchObject({ volumeUsd: null, rankCategory: 'null', completenessReason: 'unpriced_trade' });
  });

  it('returns null for incomplete coverage even when every trade is priced', async () => {
    const fixture = await setupLaunch();
    await addRound(fixture, 1, 500, onePointFive, windowEnd - 200);
    await addTrade(fixture, fixture.venueId, 600, windowEnd - 100, twoEth, 1_000_031);

    const score = await calculateLaunchVolume(pool, key(fixture.token), windowEnd, incompleteHead);

    expect(score).toMatchObject({ volumeUsd: null, rankCategory: 'null', completenessReason: 'incomplete_coverage' });
  });

  it('returns an exact zero for a complete launch with no trades in the window', async () => {
    const fixture = await setupLaunch();

    const score = await calculateLaunchVolume(pool, key(fixture.token), windowEnd, completeHead);

    expect(score).toMatchObject({ volumeUsd: '0', rankCategory: 'zero', completenessReason: 'complete', nextExpiryAt: null });
  });

  it('ignores trades on a non-official venue of the same token', async () => {
    const fixture = await setupLaunch();
    await addRound(fixture, 1, 500, onePointFive, windowEnd - 200);
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1, $2, $3, 'v3_pool', $4, $5, 1, false)`, [`${fixture.venueId}-side`, chainId, fixture.token, `0x${hex(9, 40)}`, source]);
    await addTrade(fixture, fixture.venueId, 600, windowEnd - 100, twoEth, 1_000_041);
    await addTrade(fixture, `${fixture.venueId}-side`, 601, windowEnd - 90, twoEth, 1_000_043);

    const score = await calculateLaunchVolume(pool, key(fixture.token), windowEnd, completeHead);

    expect(score.volumeUsd).toBe('3');
  });

  it('includes a trade exactly at the window start and drops it one second later', async () => {
    const fixture = await setupLaunch();
    await addRound(fixture, 1, 500, onePointFive, windowEnd - 86_400 - 10);
    await addTrade(fixture, fixture.venueId, 600, windowEnd - 86_400, twoEth, 1_000_051);

    expect((await calculateLaunchVolume(pool, key(fixture.token), windowEnd, completeHead)).volumeUsd).toBe('3');
    expect((await calculateLaunchVolume(pool, key(fixture.token), windowEnd + 1, completeHead)).volumeUsd).toBe('0');
  });
});
