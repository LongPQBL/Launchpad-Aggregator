import { formatRational } from './price.js';
import type { VenueAmounts } from './tvlReserves.js';

const Q192 = 2n ** 192n;

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) return null;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0') - fraction.length;
  const digits = BigInt(`${match[1]}${fraction}`);
  return exponent >= 0
    ? { numerator: digits * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-exponent) };
}

export function calculateTvlUsd(amounts: VenueAmounts, quoteDecimals: number, tokenDecimals: number,
  quoteUsdPrice: number): string | null {
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36
    || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) return null;
  const usd = decimalFraction(quoteUsdPrice);
  if (!usd || amounts.quoteRaw < 0n || amounts.tokenRaw < 0n) return null;

  let tokenValueQuoteRaw = 0n;
  if (amounts.basis !== 'curve_real_quote') {
    const sqrt = amounts.sqrtPriceX96;
    if (sqrt === null || sqrt <= 0n || amounts.tokenIsCurrency0 === null) return null;
    const squared = sqrt * sqrt;
    tokenValueQuoteRaw = amounts.tokenIsCurrency0
      ? amounts.tokenRaw * squared / Q192
      : amounts.tokenRaw * Q192 / squared;
  }
  return formatRational((amounts.quoteRaw + tokenValueQuoteRaw) * usd.numerator,
    10n ** BigInt(quoteDecimals) * usd.denominator, 8);
}
