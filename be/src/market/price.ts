export function formatRational(numerator: bigint, denominator: bigint, decimals: number): string {
  if (numerator < 0n || denominator <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
    throw new Error('Invalid price rational');
  }
  const whole = numerator / denominator;
  if (decimals === 0) return whole.toString();
  const fractional = ((numerator % denominator) * 10n ** BigInt(decimals) / denominator)
    .toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole.toString();
}
