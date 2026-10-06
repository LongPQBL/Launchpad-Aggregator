import { formatRational } from '../market/price.js';

const Q192 = 2n ** 192n;

/** Spot price of the displayed token, denominated in the other token, as a raw fraction — for
 * callers (e.g. FDV) that need full precision rather than poolPriceInQuote's fixed 18 decimal
 * places, which rounds a price far below 1e-18 away to "0". */
export function poolPriceRational(sqrtPriceX96: bigint, displayedDecimals: number | null,
  quoteDecimals: number | null, displayedIsCurrency0: boolean): { numerator: bigint; denominator: bigint } | null {
  if (sqrtPriceX96 <= 0n || displayedDecimals === null || quoteDecimals === null
    || !Number.isInteger(displayedDecimals) || !Number.isInteger(quoteDecimals)
    || displayedDecimals < 0 || quoteDecimals < 0 || displayedDecimals > 36 || quoteDecimals > 36) return null;
  const square = sqrtPriceX96 * sqrtPriceX96;
  return {
    numerator: (displayedIsCurrency0 ? square : Q192) * 10n ** BigInt(displayedDecimals),
    denominator: (displayedIsCurrency0 ? Q192 : square) * 10n ** BigInt(quoteDecimals),
  };
}

/** Spot price of the displayed token, denominated in the other token. */
export function poolPriceInQuote(sqrtPriceX96: bigint, displayedDecimals: number | null,
  quoteDecimals: number | null, displayedIsCurrency0: boolean): string | null {
  const rational = poolPriceRational(sqrtPriceX96, displayedDecimals, quoteDecimals, displayedIsCurrency0);
  return rational ? formatRational(rational.numerator, rational.denominator, 18) : null;
}

/** Sum already-valued trade amounts exactly as decimal strings, including exponent notation. */
export function sumUsdValues(values: readonly string[]): string {
  const parsed = values.map((value) => {
    const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match) throw new Error(`Invalid USD value: ${value}`);
    const exponent = Number(match[3] ?? '0');
    const scale = (match[2]?.length ?? 0) - exponent;
    if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1000) throw new Error('USD scale out of range');
    const digits = BigInt(`${match[1]}${match[2] ?? ''}`);
    return scale < 0 ? { digits: digits * 10n ** BigInt(-scale), scale: 0 } : { digits, scale };
  });
  const scale = Math.max(0, ...parsed.map((item) => item.scale));
  const sum = parsed.reduce((total, item) => total + item.digits * 10n ** BigInt(scale - item.scale), 0n);
  if (scale === 0) return sum.toString();
  const whole = sum / 10n ** BigInt(scale);
  const fraction = (sum % 10n ** BigInt(scale)).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
