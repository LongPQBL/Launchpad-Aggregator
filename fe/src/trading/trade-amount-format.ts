import { formatUnits } from 'viem';
import { applySlippage } from './amount';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 4 });

// Display-only. A real non-zero amount is never shown as 0 — it shows "<0.0001".
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return '0';
  const value = Number(formatUnits(amount, decimals));
  if (value < 0.0001) return '<0.0001';
  return compact.format(value);
}

// Wallet balances are truncated, never rounded up: a displayed balance must not suggest that
// the user can sell more than they hold. The raw bigint remains authoritative for comparisons.
export function formatBalanceAmount(amount: bigint, decimals: number): string {
  const [whole, fraction = ''] = formatUnits(amount, decimals).split('.');
  const visibleFraction = fraction.slice(0, 6).replace(/0+$/, '');
  if (amount > 0n && whole === '0' && !visibleFraction) return '<0.000001';
  const groupedWhole = BigInt(whole).toLocaleString('en-US');
  return visibleFraction ? `${groupedWhole}.${visibleFraction}` : groupedWhole;
}

// The row under the cards: the least the user accepts after slippage. Uses the very same
// applySlippage() the submit path feeds into minTokensOut / minQuoteOut / amountOutMinimum, so
// the number shown is the number sent. null (row hidden) when there is no quote.
export function minReceivedText(
  outputAmount: bigint | null,
  slippageBps: number | 'auto',
  venueKind: 'curve' | 'pool',
  decimals: number,
  symbol: string | null,
): string | null {
  if (outputAmount === null) return null;
  return `${formatTokenAmount(applySlippage(outputAmount, slippageBps, venueKind), decimals)} ${symbol ?? ''}`.trim();
}
