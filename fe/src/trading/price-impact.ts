import { useState } from 'react';

export type VenueKind = 'curve' | 'pool';
export type ImpactLevel = 'ok' | 'warn' | 'severe';

// A probe quote is this fraction of the real trade: small enough to sit on the pool's marginal price, large enough
// that integer rounding of the output does not dominate.
const PROBE_DIVISOR = 100n;
const MIN_PROBE_AMOUNT = 1_000n;

// A steep bonding curve moves price by a lot on any real buy, so its thresholds are looser than an AMM pool's.
const IMPACT_THRESHOLDS_BPS: Record<VenueKind, { warn: number; severe: number }> = {
  pool: { warn: 500, severe: 1500 },
  curve: { warn: 1500, severe: 3000 },
};
const SLIPPAGE_THRESHOLDS_BPS: Record<VenueKind, { high: number; low: number }> = {
  pool: { high: 500, low: 10 },
  curve: { high: 2500, low: 50 },
};

/** The size of the small reference quote for a trade, or null when the trade is too small to measure against. */
export function probeAmount(amountIn: bigint): bigint | null {
  const probe = amountIn / PROBE_DIVISOR;
  return probe >= MIN_PROBE_AMOUNT ? probe : null;
}

/**
 * How much worse the real trade's average price is than the pool's marginal price, in basis points. The pool fee is
 * paid by both quotes, so it cancels out. null when either quote is missing or empty — never a made-up 0.
 */
export function priceImpactBps(input: { amountIn: bigint; output: bigint | null; probeIn: bigint | null; probeOut: bigint | null }): number | null {
  const { amountIn, output, probeIn, probeOut } = input;
  if (output === null || probeIn === null || probeOut === null || amountIn <= 0n || probeIn <= 0n || probeOut <= 0n) return null;
  // Compare output per input unit: (output / amountIn) against (probeOut / probeIn), scaled to bps without floats.
  const actual = output * probeIn * 10_000n;
  const marginal = probeOut * amountIn;
  const bps = 10_000n - actual / marginal;
  return bps <= 0n ? 0 : Number(bps > 10_000n ? 10_000n : bps);
}

export function impactLevel(bps: number | null, venueKind: VenueKind): ImpactLevel {
  if (bps === null) return 'ok';
  const limits = IMPACT_THRESHOLDS_BPS[venueKind];
  if (bps >= limits.severe) return 'severe';
  return bps >= limits.warn ? 'warn' : 'ok';
}

export function formatImpact(bps: number): string {
  return bps > 0 && bps < 1 ? '<0.01%' : `${(bps / 100).toFixed(2)}%`;
}

export interface SlippageWarning { level: 'high' | 'low'; message: string }

/** Advice on the user's own slippage setting. 'auto' is chosen per venue by the app and never warned about. */
export function slippageWarning(slippageBps: number | 'auto', venueKind: VenueKind): SlippageWarning | null {
  if (slippageBps === 'auto') return null;
  const limits = SLIPPAGE_THRESHOLDS_BPS[venueKind];
  if (slippageBps > limits.high) {
    return { level: 'high', message: 'High slippage: your trade can be front-run (sandwiched) and fill at a much worse price.' };
  }
  if (slippageBps < limits.low) return { level: 'low', message: 'Low slippage: your trade may fail and still cost gas.' };
  return null;
}

export interface PriceImpactView { bps: number | null; level: ImpactLevel; text: string | null }

export function describePriceImpact(bps: number | null, venueKind: VenueKind): PriceImpactView {
  return { bps, level: impactLevel(bps, venueKind), text: bps === null ? null : formatImpact(bps) };
}

/**
 * A severe price impact must be acknowledged before the trade can be sent. The acknowledgement belongs to one amount:
 * changing the amount (and so the impact) asks again.
 */
export function usePriceImpactAck(amountIn: bigint, level: ImpactLevel): { acknowledged: boolean; blocked: boolean; set: (value: boolean) => void } {
  const [ackedFor, setAckedFor] = useState<bigint | null>(null);
  const acknowledged = ackedFor === amountIn;
  return { acknowledged, blocked: level === 'severe' && !acknowledged, set: (value) => setAckedFor(value ? amountIn : null) };
}
