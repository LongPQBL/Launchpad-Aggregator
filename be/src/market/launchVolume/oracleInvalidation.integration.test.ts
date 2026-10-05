import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase } from '../../db/client.js';
import { invalidateForCoverageChange, invalidateForPriceChange } from './oracleInvalidation.js';
import { upsertPriceRounds } from '../quotePricing/priceRounds.js';
import { upsertQuoteFeed } from '../quotePricing/feedRegistry.js';
import { advanceSourceCoverage } from '../../envioSync/incrementalSync.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool: drizzlePool } = createDatabase(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const quoteA: `0x${string}` = `0x${'c1'.repeat(20)}`;
const quoteB: `0x${string}` = `0x${'c2'.repeat(20)}`;
const feedA: `0x${string}` = `0x${'f1'.repeat(20)}`;
const feedB: `0x${string}` = `0x${'f2'.repeat(20)}`;
const tokenA = `0x${'e1'.repeat(20)}`;
const tokenB = `0x${'e2'.repeat(20)}`;
const sourceA = 'oracle-inval-src-a';
const sourceB = 'oracle-inval-src-b';
const venueA = 'oracle-inval-venue-a';
const venueB = 'oracle-inval-venue-b';
const tokens = [tokenA, tokenB];
const nowSeconds = Math.floor(Date.now() / 1000);

async function jobRevision(token: string): Promise<number | undefined> {
  return (await pool.query('SELECT revision FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows[0]?.revision;
}

beforeAll(async () => {
  for (const [id, factory] of [[sourceA, tokenA], [sourceB, tokenB]] as const) {
    await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
      VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [id, chainId, factory]);
  }
  for (const [token, quote, source] of [[tokenA, quoteA, sourceA], [tokenB, quoteB, sourceB]] as const) {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
      protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
      quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES ($1, $2, $3, 'Oracle inval', 'OIV', 18, 'pons', 'v2', $2, $2, 100, $4, 1, $5, 'USDC', 6, 'trading')
      ON CONFLICT DO NOTHING`, [chainId, token, source, `0x${'d'.repeat(64)}`, quote]);
  }
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'curve', $3, $4, 1, true), ($5, $2, $6, 'curve', $6, $7, 1, true) ON CONFLICT DO NOTHING`,
  [venueA, chainId, tokenA, sourceA, venueB, tokenB, sourceB]);
  for (const [venue, token, hash] of [[venueA, tokenA, '1'], [venueB, tokenB, '2']] as const) {
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index,
      timestamp, side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1, $2, $3, 500, $4, $5, 1, $6, 'buy', '1', '1', $7, 'CurveBuy', 'user_trade', $2)`,
    [chainId, token, venue, `0x${'a'.repeat(64)}`, `0x${hash.repeat(64)}`, nowSeconds - 60, token === tokenA ? quoteA : quoteB]);
  }
});

beforeEach(async () => {
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE token_address = ANY($1)', [tokens]);
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, tokens]);
  await pool.query('DELETE FROM venues WHERE id = ANY($1)', [[venueA, venueB]]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, tokens]);
  await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[sourceA, sourceB]]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = ANY($2)', [chainId, [feedA, feedB]]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = ANY($2)', [chainId, [quoteA, quoteB]]);
  await drizzlePool.end();
  await pool.end();
});

describe('oracle invalidation', () => {
  it('invalidates only launches that quote the changed asset and have official trades in the affected window', async () => {
    const count = await invalidateForPriceChange(db, { chainId, quoteAssetAddress: quoteA, feedAddress: feedA, fromBlock: 0n, toBlock: 1_000n });
    expect(count).toBe(1);
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await jobRevision(tokenB)).toBeUndefined();
  });

  it('invalidates the launches of an inserted or corrected round at its block range, not earlier trades', async () => {
    await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
      VALUES ($1, $2, 1, 100000000, 8, $3, $3, 500, 0) ON CONFLICT DO NOTHING`, [chainId, feedA, nowSeconds - 120]);
    expect(await invalidateForPriceChange(db, { chainId, quoteAssetAddress: quoteA, feedAddress: feedA, fromBlock: 500n, toBlock: 500n })).toBe(1);
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await invalidateForPriceChange(db, { chainId, quoteAssetAddress: quoteA, feedAddress: feedA, fromBlock: 501n, toBlock: 600n })).toBe(0);
  });

  it('invalidates the quoting launches when a verified feed is remapped or revoked, across the whole block range', async () => {
    const count = await invalidateForPriceChange(db, { chainId, quoteAssetAddress: quoteA, feedAddress: feedA, fromBlock: 0n, toBlock: 10_000_000n });
    expect(count).toBe(1);
    expect(await jobRevision(tokenB)).toBeUndefined();
  });

  it('invalidates the launch whose source coverage changed, and leaves other launches alone', async () => {
    expect(await invalidateForCoverageChange(db, [sourceA])).toBe(1);
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await jobRevision(tokenB)).toBeUndefined();
    expect(await invalidateForCoverageChange(db, [])).toBe(0);
  });

  it('maps a curve venue to the pons-v2-curve coverage source, the same mapping the API coverage uses', async () => {
    expect(await invalidateForCoverageChange(db, ['pons-v2-curve'])).toBe(2);
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await jobRevision(tokenB)).toBe(1);
  });

  it('invalidates only when a source crosses the head, not on routine progress that changes nothing', async () => {
    await advanceSourceCoverage(db, { id: sourceA }, 1000n, 1000n);
    expect(await jobRevision(tokenA)).toBe(1);
    await advanceSourceCoverage(db, { id: sourceA }, 1000n, 1000n);
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await jobRevision(tokenB)).toBeUndefined();
  });

  it('invalidates the quoting launch when a round is written through upsertPriceRounds', async () => {
    await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
      VALUES ($1, $2, $3, 'test', 'verified', now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
    [chainId, quoteA, feedA]);
    const round = { roundId: 2n, answerRaw: 100_000_000n, decimals: 8, startedAt: nowSeconds - 120, updatedAt: nowSeconds - 120, blockNumber: 500n, logIndex: 0 };
    expect(await upsertPriceRounds(pool, chainId, feedA, [round])).toBe(1);
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await jobRevision(tokenB)).toBeUndefined();
  });

  it('invalidates the quoting launch when upsertQuoteFeed remaps its feed, and not when the mapping is unchanged', async () => {
    const feed = { chainId, quoteAssetAddress: quoteA, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' as const, now: new Date() };
    await upsertQuoteFeed(pool, { ...feed, feedAddress: feedA });
    expect(await jobRevision(tokenA)).toBeUndefined();
    await upsertQuoteFeed(pool, { ...feed, feedAddress: feedB });
    expect(await jobRevision(tokenA)).toBe(1);
    expect(await jobRevision(tokenB)).toBeUndefined();
  });
});
