import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { __resetUsdPriceCacheForTests, readUsdPrice, readUsdPriceAtBlock } from '../usdPricing.js';
import { valueTradeUsd } from './tradeValuation.js';
import { maintainRollingWindows } from './priceEnrichment.js';
import { STOCK_REFERENCE_SOURCE, syncStockReferenceFeeds, type StockReferenceDeps } from './stockReference.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

// A private chain id keeps this file from touching (or being touched by) other test files' feeds and pools.
const CHAIN = 900_046;
const STOCK = '0x5e81213613b6b86eab4c6c50d718d34359459786';
const OTHER = '0x1111111111111111111111111111111111111111';
const POOL_ID = '0xstockreferencepool';
const NOW = Date.UTC(2026, 9, 15, 15, 10) / 1000;

const bars = (closes: [string, string][]) => ({ results: [{ historicals: closes.map(([begins_at, close_price]) => ({ begins_at, close_price })) }] });
// One block per second, so a timestamp maps to the block of the same number.
const locate = async (seconds: number) => ({ block: BigInt(seconds), timestamp: seconds });

function deps(overrides: Partial<StockReferenceDeps> = {}): StockReferenceDeps {
  return {
    fetchJson: async (url) => url.includes('interval=hour')
      ? bars([['2026-10-15T13:00:00Z', '200.000000'], ['2026-10-15T14:00:00Z', '205.000000']])
      : bars([['2026-10-15T15:00:00Z', '208.570000'], ['2026-10-15T15:05:00Z', '999.000000']]),
    symbolOf: async (address) => (address === STOCK ? 'TTWO' : null),
    locate,
    ...overrides,
  };
}

async function clean() {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1', [CHAIN]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1', [CHAIN]);
  await pool.query('DELETE FROM price_jobs WHERE chain_id = $1', [CHAIN]);
  await pool.query('DELETE FROM pool_catalog WHERE chain_id = $1', [CHAIN]);
}

beforeEach(async () => {
  __resetUsdPriceCacheForTests();
  await clean();
  await pool.query(
    `INSERT INTO pool_catalog (chain_id, protocol, pool_id, currency0, currency1, fee, tick_spacing, hooks, block_number, block_hash, tx_hash, log_index, verified)
     VALUES ($1, 'uniswap_v4', $2, $3, $4, 3000, 60, '0x0000000000000000000000000000000000000000', 1, '0xhash', '0xtx', 0, true)`,
    [CHAIN, POOL_ID, OTHER, STOCK]);
});
afterAll(async () => { await clean(); await pool.end(); });

describe('syncStockReferenceFeeds', () => {
  it('registers an uncovered stock, stores its finished bars and prices it from the newest round', async () => {
    const report = await syncStockReferenceFeeds(pool, CHAIN, deps(), new Date(NOW * 1000));
    expect(report).toMatchObject({ registered: 1, feeds: 1 });

    const feed = await pool.query('SELECT feed_address, discovery_source, aggregator_address FROM quote_usd_feeds WHERE chain_id = $1', [CHAIN]);
    expect(feed.rows).toEqual([{ feed_address: STOCK, discovery_source: STOCK_REFERENCE_SOURCE, aggregator_address: null }]);
    // Two hourly bars (ending 14:00 and 15:00) and two 5-minute bars (ending 15:05 and 15:10); all have closed by 15:10.
    const rounds = await pool.query('SELECT updated_at, answer_raw FROM quote_usd_price_rounds WHERE chain_id = $1 ORDER BY updated_at', [CHAIN]);
    expect(rounds.rows.map((row) => Number(row.answer_raw) / 1e8)).toEqual([200, 205, 208.57, 999]);

    const price = await readUsdPrice(pool, { readContract: async () => { throw new Error('must not read a contract'); } }, CHAIN, STOCK, () => NOW * 1000);
    expect(price?.priceUsd).toBe(999);
  });

  it('is idempotent: a second pass stores nothing new', async () => {
    await syncStockReferenceFeeds(pool, CHAIN, deps(), new Date(NOW * 1000));
    const second = await syncStockReferenceFeeds(pool, CHAIN, deps(), new Date(NOW * 1000));
    expect(second.inserted).toBe(0);
    expect(second.registered).toBe(0);
  });

  it('does not register an asset whose symbol the price API does not serve, nor an unknown asset', async () => {
    const report = await syncStockReferenceFeeds(pool, CHAIN, deps({ fetchJson: async () => ({ results: [] }) }), new Date(NOW * 1000));
    expect(report.registered).toBe(0);
    expect((await pool.query('SELECT 1 FROM quote_usd_feeds WHERE chain_id = $1', [CHAIN])).rowCount).toBe(0);
  });

  it('values a trade with the last round before it and refuses a round older than 24 hours', async () => {
    await syncStockReferenceFeeds(pool, CHAIN, deps(), new Date(NOW * 1000));
    const trade = { timestamp: NOW - 100, quoteAmountRaw: 10n ** 18n, quoteAssetDecimals: 18, blockNumber: BigInt(NOW - 100), logIndex: 3 };
    // 100 s before 15:10: the 15:10 round does not exist yet for this trade, the 15:05 round (208.57) is the newest before it.
    expect(await valueTradeUsd(pool, CHAIN, STOCK, trade)).toEqual({ status: 'priced', usdValue: '208.57' });
    const stale = await valueTradeUsd(pool, CHAIN, STOCK, { ...trade, timestamp: NOW + 3 * 86_400, blockNumber: BigInt(NOW + 3 * 86_400) });
    expect(stale.status).not.toBe('priced');
    const atBlock = await readUsdPriceAtBlock(pool, { readContract: async () => { throw new Error('no contract'); } }, CHAIN, STOCK, BigInt(NOW), NOW);
    expect(atBlock).toBe(999);
  });

  it('is left out of the on-chain round backfill windows', async () => {
    await syncStockReferenceFeeds(pool, CHAIN, deps(), new Date(NOW * 1000));
    expect(await maintainRollingWindows(pool, CHAIN, new Date(NOW * 1000))).toBe(0);
  });
});
