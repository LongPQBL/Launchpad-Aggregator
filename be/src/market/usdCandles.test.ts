import { describe, expect, it } from 'vitest';
import { buildUsdCandles, type UsdPricedTrade } from './usdCandles.js';

const dec = 18;
const e18 = 10n ** 18n;
function trade(block: number, logIndex: number, timestamp: number, tokens: number, usdValue: string | null): UsdPricedTrade {
  return { timestamp, blockNumber: BigInt(block), logIndex, tokenAmountRaw: BigInt(tokens) * e18, tokenDecimals: dec, usdValue };
}

describe('buildUsdCandles', () => {
  it('builds open, high, low, and close of the per-token USD price in trade order, and sums USD volume', () => {
    const candles = buildUsdCandles([
      trade(10, 0, 1_000, 1, '2'),
      trade(10, 1, 1_005, 1, '3'),
      trade(11, 0, 1_010, 1, '1'),
      trade(11, 1, 1_015, 1, '4'),
    ], 60);

    expect(candles).toEqual([{ bucketStart: 960, intervalSeconds: 60, open: 2, high: 4, low: 1, close: 4, volumeUsd: 10 }]);
  });

  it('divides by the token amount so the candle is priced per token, not per trade', () => {
    const [candle] = buildUsdCandles([{ timestamp: 1_000, blockNumber: 1n, logIndex: 0, tokenAmountRaw: 2n * e18, tokenDecimals: 18, usdValue: '6' }], 60);
    expect(candle?.open).toBe(3);
  });

  it('splits trades into separate buckets by interval start', () => {
    const candles = buildUsdCandles([trade(10, 0, 1_000, 1, '2'), trade(11, 0, 1_100, 1, '5')], 60);
    expect(candles.map((candle) => candle.bucketStart)).toEqual([960, 1_080]);
  });

  it('omits a bucket that contains any unpriced trade instead of showing a partial or zero candle', () => {
    const candles = buildUsdCandles([trade(10, 0, 1_000, 1, '2'), trade(10, 1, 1_010, 1, null)], 60);
    expect(candles).toEqual([]);
  });

  it('omits a bucket with a zero token amount, because no per-token price exists for it', () => {
    const candles = buildUsdCandles([{ timestamp: 1_000, blockNumber: 1n, logIndex: 0, tokenAmountRaw: 0n, tokenDecimals: 18, usdValue: '2' }], 60);
    expect(candles).toEqual([]);
  });
});
