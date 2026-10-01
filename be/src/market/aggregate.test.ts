import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import type { Trade } from '../domain/types.js';
import { buildOfficialCandles, compute52WeekHighLow, sumOfficialQuoteVolume, type OfficialMarket } from './aggregate.js';
import { formatRational } from './price.js';

const token = '0x1111111111111111111111111111111111111111' as Address;
const quote = '0x2222222222222222222222222222222222222222' as Address;
const otherQuote = '0x3333333333333333333333333333333333333333' as Address;
const tx = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hash;
const blockHash = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hash;
const market: OfficialMarket = { chainId: 4663, tokenAddress: token, quoteAssetAddress: quote, venueIds: new Set(['curve', 'pool']), complete: true };

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    chainId: 4663, tokenAddress: token, venueId: 'curve', blockNumber: 100n, blockHash, txHash: tx,
    logIndex: 1, timestamp: 10, side: 'buy', tokenAmountRaw: 10n, quoteAmountRaw: 100n,
    quoteAssetAddress: quote, sourceEvent: 'CurveBuy', activityKind: 'user_trade', priceNumeratorRaw: 1n, priceDenominatorRaw: 1n,
    traderAddress: '0x4444444444444444444444444444444444444444' as Address,
    ...overrides,
  };
}

describe('official market aggregation', () => {
  it('builds OHLC by event order across curve and graduated pool', () => {
    const trades = [
      trade({ timestamp: 12, blockNumber: 102n, venueId: 'curve', priceNumeratorRaw: 3n, quoteAmountRaw: 30n, logIndex: 2 }),
      trade({ timestamp: 10, blockNumber: 100n, venueId: 'curve', priceNumeratorRaw: 1n, quoteAmountRaw: 10n }),
      trade({ timestamp: 14, blockNumber: 103n, venueId: 'pool', priceNumeratorRaw: 2n, quoteAmountRaw: 20n, logIndex: 3 }),
    ];
    const candles = buildOfficialCandles(trades, 60, market);
    expect(candles).toEqual([{ chainId: 4663, tokenAddress: token, quoteAssetAddress: quote, intervalSeconds: 60,
      bucketStart: 0, open: '1', high: '3', low: '1', close: '2', quoteVolumeRaw: 60n }]);
  });

  it('excludes an unrelated pool from candles and volume', () => {
    const trades = [trade(), trade({ venueId: 'unofficial', quoteAmountRaw: 999n, priceNumeratorRaw: 999n, logIndex: 2 })];
    expect(sumOfficialQuoteVolume(trades, 0, market).amountRaw).toBe(100n);
    expect(buildOfficialCandles(trades, 60, market)[0].high).toBe('1');
  });

  it('refuses to add quote amounts from different assets', () => {
    const trades = [trade(), trade({ quoteAssetAddress: otherQuote, venueId: 'pool', logIndex: 2 })];
    expect(() => sumOfficialQuoteVolume(trades, 0, market)).toThrow(/quote asset/i);
  });

  it('returns unknown rather than zero when the relevant source is incomplete', () => {
    expect(sumOfficialQuoteVolume([], 0, { ...market, complete: false })).toEqual({ quoteAssetAddress: quote, amountRaw: null, complete: false });
    expect(sumOfficialQuoteVolume([], 0, market)).toEqual({ quoteAssetAddress: quote, amountRaw: 0n, complete: true });
  });

  it('does not invent a candle from a curve trade without verified spot price', () => {
    expect(buildOfficialCandles([trade({ priceNumeratorRaw: null, priceDenominatorRaw: null })], 60, market)).toEqual([]);
  });

  it('formats a large rational using bigint without floating-point money arithmetic', () => {
    expect(formatRational(10n ** 40n + 1n, 10n ** 40n, 18)).toBe('1');
    expect(formatRational(1n, 4n, 18)).toBe('0.25');
  });
});

describe('compute52WeekHighLow', () => {
  it('returns null/null for an empty candle set instead of 0', () => {
    expect(compute52WeekHighLow([])).toEqual({ high: null, low: null });
  });

  it('returns the max high and min low across the given candles as decimal strings', () => {
    const candles = [
      { high: '0.05', low: '0.01' },
      { high: '0.08', low: '0.02' },
      { high: '0.03', low: '0.001' },
    ];
    expect(compute52WeekHighLow(candles)).toEqual({ high: '0.08', low: '0.001' });
  });
});
