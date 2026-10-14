// The bonding curve itself: marginal price against how far the curve is from graduating. A Pons curve is constant-product with a
// virtual quote reserve (quote x token = k): after `p` of the graduation threshold has been paid in, its quote reserve is
// virtual + p x threshold and its price is quoteReserve² / k. Everything is read from the curve's reserves; nothing is estimated.
export interface CurveReserves {
  quoteReserve: string; tokenReserve: string; realQuoteReserve: string; graduationThreshold: string; quoteDecimals: number; tokenDecimals: number;
}
export interface CurvePoint {
  /** 0 = nothing paid in, 1 = graduation. */
  progress: number;
  /** Quote asset per token. */
  price: number;
  /** Quote paid into the curve so far at this point, in whole quote units. */
  quotePaidIn: number;
  /** Tokens sold from the curve's start; null when the curve started with no virtual reserve (the start is unbounded). */
  tokensSold: number | null;
}
export interface CurveShape { points: CurvePoint[]; current: CurvePoint; graduation: CurvePoint }

export function buildCurveShape(reserves: CurveReserves, steps = 80): CurveShape | null {
  const quote = Number(reserves.quoteReserve);
  const token = Number(reserves.tokenReserve);
  const real = Number(reserves.realQuoteReserve);
  const threshold = Number(reserves.graduationThreshold);
  if (![quote, token, real, threshold].every(Number.isFinite) || quote <= 0 || token <= 0 || threshold <= 0 || real < 0) return null;
  const virtual = quote - real;
  if (virtual < 0) return null;
  const k = quote * token;
  const scaleQuote = 10 ** reserves.quoteDecimals;
  const scaleToken = 10 ** reserves.tokenDecimals;
  const at = (progress: number): CurvePoint => {
    const reserve = virtual + progress * threshold;
    return {
      progress,
      price: (reserve * reserve / k) * 10 ** (reserves.tokenDecimals - reserves.quoteDecimals),
      quotePaidIn: (progress * threshold) / scaleQuote,
      tokensSold: virtual > 0 ? (k / virtual - k / reserve) / scaleToken : null,
    };
  };
  const now = Math.min(1, real / threshold);
  const points = Array.from({ length: steps + 1 }, (_, index) => at(index / steps));
  return { points, current: at(now), graduation: at(1) };
}
