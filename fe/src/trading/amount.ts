import { parseUnits } from 'viem';
import { resolveAutoSlippageBps } from './use-trade-settings';

// Keep swap inputs editable as text while discarding signs, letters and duplicate decimal points.
// Accept a comma as the decimal separator for keyboards that emit it in decimal mode.
export function sanitizeAmountInput(value: string): string {
  const normalized = value.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const decimal = normalized.indexOf('.');
  return decimal === -1 ? normalized : `${normalized.slice(0, decimal + 1)}${normalized.slice(decimal + 1).replace(/\./g, '')}`;
}

// A plain decimal string only — rejects scientific notation ("1e5") and anything else
// viem's parseUnits would throw on. Callers run this during render (computing amountIn),
// so a throw here would crash the whole page, not just one trading panel.
export function parseAmountSafe(amount: string, decimals: number): bigint {
  if (amount === '' || !/^\d*\.?\d*$/.test(amount)) return 0n;
  try {
    return parseUnits(amount, decimals);
  } catch {
    return 0n;
  }
}

export function applySlippage(amount: bigint, slippageBps: number | 'auto', venueKind: 'curve' | 'pool'): bigint {
  const rawBps = slippageBps === 'auto' ? resolveAutoSlippageBps(venueKind) : slippageBps;
  // Clamp defensively — a custom value above 100% (10_000 bps) would make (10_000 - bps)
  // negative, producing a negative minimum-output and throwing when it's later ABI-encoded.
  // The settings UI already caps what a user can type, but this is the one place that actually
  // computes the on-chain parameter, so it must never trust an out-of-range value to reach it.
  const bps = Math.min(10_000, Math.max(0, rawBps));
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
