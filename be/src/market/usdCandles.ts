export interface UsdPricedTrade {
  timestamp: number;
  blockNumber: bigint;
  logIndex: number;
  tokenAmountRaw: bigint;
  tokenDecimals: number;
  usdValue: string | null;
}

export interface UsdCandle {
  bucketStart: number;
  intervalSeconds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

// Per-token USD price is the trade's USD value divided by the token amount it moved, so it is the
// execution price a trader paid. A bucket with any unpriced trade, or a zero-amount trade, is left
// out: a partial candle would look like a real price.
export function buildUsdCandles(trades: readonly UsdPricedTrade[], intervalSeconds: number): UsdCandle[] {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) throw new Error('Invalid candle interval');
  const buckets = new Map<number, UsdPricedTrade[]>();
  for (const trade of trades) {
    const bucket = Math.floor(trade.timestamp / intervalSeconds) * intervalSeconds;
    const rows = buckets.get(bucket) ?? [];
    rows.push(trade);
    buckets.set(bucket, rows);
  }
  const candles: UsdCandle[] = [];
  for (const [bucketStart, rows] of buckets) {
    if (rows.some((row) => row.usdValue === null || row.tokenAmountRaw === 0n)) continue;
    rows.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
    const prices = rows.map((row) => {
      const tokens = Number(row.tokenAmountRaw) / 10 ** row.tokenDecimals;
      return Number(row.usdValue) / tokens;
    });
    candles.push({
      bucketStart,
      intervalSeconds,
      open: prices[0]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices.at(-1)!,
      volumeUsd: rows.reduce((sum, row) => sum + Number(row.usdValue), 0),
    });
  }
  return candles.sort((a, b) => a.bucketStart - b.bucketStart);
}
