// Uniswap V2's constant-product swap, exactly as UniswapV2Library computes it (0.3% fee: 997 of every 1000 counts).
const FEE_NUMERATOR = 997n;
const FEE_DENOMINATOR = 1000n;

export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint | null {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null;
  const withFee = amountIn * FEE_NUMERATOR;
  const out = (withFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + withFee);
  return out > 0n ? out : null;
}

// The input that buys exactly `amountOut` (rounded up, as the library does). null when the pair cannot pay that much.
export function v2AmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint | null {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n || amountOut >= reserveOut) return null;
  return (reserveIn * amountOut * FEE_DENOMINATOR) / ((reserveOut - amountOut) * FEE_NUMERATOR) + 1n;
}
