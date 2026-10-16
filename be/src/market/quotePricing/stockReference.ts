import type { Pool } from 'pg';
import { parseUnits } from 'viem';
import type { Address } from 'viem';
import { upsertQuoteFeed } from './feedRegistry.js';
import { upsertPriceRounds, type PriceRound } from './priceRounds.js';

// Tokenized stocks that have no on-chain oracle feed are priced from the stock itself (1 token = 1 share): the closing price of each
// finished bar of Robinhood's public historicals API is stored as an oracle round in the same table the on-chain feeds use, so trade
// valuation, volume rollups, candles and TVL read it unchanged. The "feed" of such an asset is the token's own address.
export const STOCK_REFERENCE_SOURCE = 'stock-reference';

const HISTORICALS_URL = 'https://api.robinhood.com/marketdata/historicals/';
const DECIMALS = 8;
const HISTORY_SECONDS = 90 * 86_400;
// `logIndex` is a Postgres integer: the largest value places the round after every trade of the block it is located in.
const MAX_LOG_INDEX = 2_147_483_647;

export interface StockBar { begins_at: string; close_price: string }
export type BlockLocate = (seconds: number) => Promise<{ block: bigint; timestamp: number } | null>;
// `lookbackSeconds` is how far back a window's bars are stored (the API may return more).
interface Window { interval: '5minute' | 'hour'; span: 'day' | 'week' | '3month'; barSeconds: number; lookbackSeconds: number }
const HOURLY_HISTORY: Window = { interval: 'hour', span: '3month', barSeconds: 3600, lookbackSeconds: HISTORY_SECONDS };
const RECENT_WEEK: Window = { interval: '5minute', span: 'week', barSeconds: 300, lookbackSeconds: 7 * 86_400 };
const RECENT_DAY: Window = { interval: '5minute', span: 'day', barSeconds: 300, lookbackSeconds: 86_400 };

/** The usable bars of a historicals response: a parseable start time and a positive close. */
export function parseStockBars(response: unknown): StockBar[] {
  const results = (response as { results?: unknown } | null)?.results;
  const historicals = Array.isArray(results) ? (results[0] as { historicals?: unknown } | undefined)?.historicals : undefined;
  if (!Array.isArray(historicals)) return [];
  const bars: StockBar[] = [];
  for (const raw of historicals as { begins_at?: unknown; close_price?: unknown }[]) {
    if (typeof raw.begins_at !== 'string' || typeof raw.close_price !== 'string' || Number.isNaN(Date.parse(raw.begins_at))) continue;
    if (!/^\d+(\.\d+)?$/.test(raw.close_price) || Number(raw.close_price) <= 0) continue;
    bars.push({ begins_at: raw.begins_at, close_price: raw.close_price });
  }
  return bars;
}

/**
 * One round per finished bar newer than `afterSeconds`: priced at the bar's close, dated at its end, located at the last block at or before that
 * moment. A bar that has not closed yet is left for a later pass (its close would still move), and one whose block cannot be found is skipped.
 */
export async function barsToRounds(bars: readonly StockBar[], barSeconds: number, nowSeconds: number, afterSeconds: number, locate: BlockLocate): Promise<PriceRound[]> {
  const rounds: PriceRound[] = [];
  for (const bar of bars) {
    const end = Math.floor(Date.parse(bar.begins_at) / 1000) + barSeconds;
    if (end > nowSeconds || end <= afterSeconds) continue;
    const located = await locate(end);
    if (!located) continue;
    rounds.push({ roundId: BigInt(end), answerRaw: parseUnits(bar.close_price, DECIMALS),
      decimals: DECIMALS, startedAt: end - barSeconds, updatedAt: end, blockNumber: located.block, logIndex: MAX_LOG_INDEX });
  }
  return rounds;
}

export interface StockReferenceDeps {
  fetchJson(url: string): Promise<unknown>;
  /** The stock symbol of a tokenized asset on this chain (Robinhood's asset directory), or null. */
  symbolOf(address: string): Promise<string | null>;
  locate: BlockLocate;
}
export interface StockReferenceReport { registered: number; feeds: number; inserted: number }

// Quote assets the chain's launches and pools use that no verified feed covers yet.
async function uncoveredQuoteAssets(pool: Pool, chainId: number): Promise<string[]> {
  const result = await pool.query(
    `SELECT address FROM (
       SELECT quote_asset_address AS address FROM launches WHERE chain_id = $1
       UNION SELECT currency0 FROM pool_catalog WHERE chain_id = $1
       UNION SELECT currency1 FROM pool_catalog WHERE chain_id = $1
     ) assets
     WHERE address <> '0x0000000000000000000000000000000000000000'
       AND NOT EXISTS (SELECT 1 FROM quote_usd_feeds f WHERE f.chain_id = $1 AND f.quote_asset_address = assets.address AND f.verification_status = 'verified')`,
    [chainId]);
  return (result.rows as { address: string }[]).map((row) => row.address.toLowerCase());
}

async function fetchBars(deps: StockReferenceDeps, symbol: string, window: Window): Promise<StockBar[]> {
  const query = new URLSearchParams({ symbols: symbol, interval: window.interval, span: window.span, bounds: '24_7' });
  return parseStockBars(await deps.fetchJson(`${HISTORICALS_URL}?${query.toString()}`));
}

/**
 * Registers the stock-reference feed of every uncovered tokenized stock (its symbol is in the asset directory and the price API knows it), then
 * stores the rounds of each stock-reference feed: three months of hourly bars the first time, afterwards only the finished 5-minute bars.
 */
export async function syncStockReferenceFeeds(pool: Pool, chainId: number, deps: StockReferenceDeps, now: Date): Promise<StockReferenceReport> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const report: StockReferenceReport = { registered: 0, feeds: 0, inserted: 0 };

  for (const address of await uncoveredQuoteAssets(pool, chainId)) {
    const symbol = await deps.symbolOf(address);
    if (!symbol) continue;
    // Only a symbol the price API actually serves is registered; the directory also lists assets without a stock behind them.
    if ((await fetchBars(deps, symbol, RECENT_DAY)).length === 0 && (await fetchBars(deps, symbol, RECENT_WEEK)).length === 0) continue;
    await upsertQuoteFeed(pool, { chainId, quoteAssetAddress: address as Address, feedAddress: address as Address, aggregatorAddress: null,
      discoverySource: STOCK_REFERENCE_SOURCE, verificationStatus: 'verified', now });
    report.registered += 1;
  }

  const feeds = await pool.query(
    `SELECT f.quote_asset_address, f.feed_address,
            COALESCE((SELECT min(r.updated_at) FROM quote_usd_price_rounds r WHERE r.chain_id = f.chain_id AND r.feed_address = f.feed_address), 0) AS oldest,
            COALESCE((SELECT max(r.updated_at) FROM quote_usd_price_rounds r WHERE r.chain_id = f.chain_id AND r.feed_address = f.feed_address), 0) AS newest,
            (SELECT min(t.timestamp) FROM trades t WHERE t.chain_id = f.chain_id AND t.quote_asset_address = f.quote_asset_address) AS first_trade
     FROM quote_usd_feeds f
     WHERE f.chain_id = $1 AND f.discovery_source = $2 AND f.verification_status = 'verified'`, [chainId, STOCK_REFERENCE_SOURCE]);
  for (const row of feeds.rows as { quote_asset_address: string; feed_address: string; oldest: string | number; newest: string | number; first_trade: string | number | null }[]) {
    const symbol = await deps.symbolOf(row.quote_asset_address);
    if (!symbol) continue;
    report.feeds += 1;
    const oldest = Number(row.oldest);
    const newest = Number(row.newest);
    // History only reaches back to a day before the first trade that needs a price (older rounds could never value anything), and only as far as the
    // price API's three months. When an older trade shows up later, the next pass extends the history back to it.
    const needFrom = Math.max(nowSeconds - HISTORY_SECONDS, (row.first_trade === null ? nowSeconds : Number(row.first_trade)) - 86_400);
    const store = async (window: Window, from: number, to: number) => {
      const bars = (await fetchBars(deps, symbol, window)).filter((bar) => {
        const end = Math.floor(Date.parse(bar.begins_at) / 1000) + window.barSeconds;
        return end <= to;
      });
      report.inserted += await upsertPriceRounds(pool, chainId, row.feed_address, await barsToRounds(bars, window.barSeconds, nowSeconds, from, deps.locate));
    };
    if (oldest === 0 || oldest > needFrom + 2 * 3600) await store(HOURLY_HISTORY, needFrom, oldest === 0 ? nowSeconds : oldest);
    const recent = newest > 0 && nowSeconds - newest > 6 * 3600 ? RECENT_WEEK : RECENT_DAY;
    await store(recent, Math.max(newest, needFrom, nowSeconds - recent.lookbackSeconds), nowSeconds);
  }
  return report;
}
