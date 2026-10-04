import type { Address } from 'viem';
import type { Trade } from '../domain/types.js';
import { formatRational } from './price.js';

export interface OfficialMarket { chainId: number; tokenAddress: Address; quoteAssetAddress: Address; venueIds: ReadonlySet<string>; complete: boolean }
export interface Candle { chainId: number; tokenAddress: Address; quoteAssetAddress: Address; intervalSeconds: number; bucketStart: number; open: string; high: string; low: string; close: string; quoteVolumeRaw: bigint }
export interface QuoteVolume { quoteAssetAddress: Address; amountRaw: bigint | null; complete: boolean }

function officialTrades(trades: readonly Trade[], market: OfficialMarket): Trade[] {
  return trades.filter((trade) => {
    if (!market.venueIds.has(trade.venueId)) return false;
    if (trade.chainId !== market.chainId || trade.tokenAddress.toLowerCase() !== market.tokenAddress.toLowerCase()) {
      throw new Error('Official venue trade does not match market identity');
    }
    if (trade.quoteAssetAddress.toLowerCase() !== market.quoteAssetAddress.toLowerCase()) {
      throw new Error('Cannot aggregate different quote assets');
    }
    return true;
  });
}

function comparePrice(a: Trade, b: Trade): number {
  const left = a.priceNumeratorRaw! * b.priceDenominatorRaw!;
  const right = b.priceNumeratorRaw! * a.priceDenominatorRaw!;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildOfficialCandles(trades: readonly Trade[], intervalSeconds: number, market: OfficialMarket): Candle[] {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) throw new Error('Invalid candle interval');
  const byBucket = new Map<number, Trade[]>();
  for (const trade of officialTrades(trades, market)) {
    const bucket = Math.floor(trade.timestamp / intervalSeconds) * intervalSeconds;
    const rows = byBucket.get(bucket) ?? [];
    rows.push(trade);
    byBucket.set(bucket, rows);
  }
  const result: Candle[] = [];
  for (const [bucketStart, rows] of byBucket) {
    if (rows.some((trade) => trade.priceNumeratorRaw === null || trade.priceDenominatorRaw === null)) continue;
    rows.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
    const high = rows.reduce((best, row) => comparePrice(row, best) > 0 ? row : best, rows[0]);
    const low = rows.reduce((best, row) => comparePrice(row, best) < 0 ? row : best, rows[0]);
    const price = (trade: Trade) => formatRational(trade.priceNumeratorRaw!, trade.priceDenominatorRaw!, 18);
    result.push({ chainId: market.chainId, tokenAddress: market.tokenAddress, quoteAssetAddress: market.quoteAssetAddress,
      intervalSeconds, bucketStart, open: price(rows[0]), high: price(high), low: price(low), close: price(rows.at(-1)!),
      quoteVolumeRaw: rows.reduce((sum, trade) => sum + trade.quoteAmountRaw, 0n) });
  }
  return result.sort((a, b) => a.bucketStart - b.bucketStart);
}

export function compute52WeekHighLow(candles: readonly { high: string; low: string }[]): { high: string | null; low: string | null } {
  if (candles.length === 0) return { high: null, low: null };
  let high = Number(candles[0]!.high);
  let low = Number(candles[0]!.low);
  let highStr = candles[0]!.high;
  let lowStr = candles[0]!.low;
  for (const candle of candles) {
    const h = Number(candle.high);
    const l = Number(candle.low);
    if (h > high) { high = h; highStr = candle.high; }
    if (l < low) { low = l; lowStr = candle.low; }
  }
  return { high: highStr, low: lowStr };
}

// The sort below is a *stable* sort by timestamp alone (JS's Array.sort has been required to be
// stable since ES2019) — when two trades share a timestamp, this function keeps the caller's
// input order for them. Callers MUST pass trades pre-ordered by (blockNumber, logIndex) ascending
// so same-second ties resolve deterministically to the chronologically-latest trade, matching
// CLAUDE.md's exact (blockNumber, logIndex) ordering rule — see store.ts's highLowResult query
// (final-review Important 2).
export function computePriceChange(trades: readonly { timestamp: number; price: string }[], nowSeconds: number, windowSeconds: number): string | null {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const latestAtOrBefore = (boundary: number): string | null => {
    let result: string | null = null;
    for (const trade of sorted) {
      if (trade.timestamp > boundary) break;
      result = trade.price;
    }
    return result;
  };
  const current = latestAtOrBefore(nowSeconds);
  const past = latestAtOrBefore(nowSeconds - windowSeconds);
  if (current === null || past === null) return null;
  const currentNum = Number(current);
  const pastNum = Number(past);
  if (pastNum === 0) return null;
  const change = ((currentNum - pastNum) / pastNum) * 100;
  // Fixed precision, never scientific/exponent notation: a raw `String(change)` can produce a
  // 16-digit float or "1e-8"-style notation for a real trade price, which is unusable as a
  // displayed percentage (final-review Important 1).
  const trimmed = change.toFixed(4).replace(/\.?0+$/, '') || '0';
  return trimmed === '-0' ? '0' : trimmed;
}

export function sumOfficialQuoteVolume(trades: readonly Trade[], since: number, market: OfficialMarket): QuoteVolume {
  if (!Number.isInteger(since)) throw new Error('Invalid volume time bound');
  const relevant = officialTrades(trades, market).filter((trade) => trade.timestamp >= since);
  return { quoteAssetAddress: market.quoteAssetAddress,
    amountRaw: market.complete ? relevant.reduce((sum, trade) => sum + trade.quoteAmountRaw, 0n) : null,
    complete: market.complete };
}
