export function formatQuote(value: string | null, symbol: string | null): string {
  if (value === null) return '—';
  return `${value} ${symbol ?? '—'}`;
}

// Below 1 unit, baseDecimals alone would round a routine Pons-scale value (FDV in the low cents,
// a per-token price far below $1) away to "0" — add enough extra digits to keep it meaningful.
// At or above 1 unit, every caller's stated baseDecimals applies unchanged.
function dynamicDecimals(numeric: number, baseDecimals: number): number {
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return baseDecimals;
  return -Math.floor(Math.log10(numeric)) + baseDecimals - 1;
}

// For a per-token unit price, not a token/quote amount — formatQuote above keeps those exact,
// unrounded.
export function formatPrice(value: string | null, symbol: string | null): string {
  if (value === null) return '—';
  const numeric = Number(value);
  return `${numeric.toFixed(dynamicDecimals(numeric, 2))} ${symbol ?? '—'}`;
}

// decimals is required, not defaulted: callers state their own context explicitly (1 for list/detail
// figures — FDV, TVL, market cap, volume, liquidity; 2 for transaction-row figures) rather than
// silently inheriting whatever a shared default happens to be. Only applies once the value reaches
// 1 unit — see dynamicDecimals.
export function formatUsd(value: string | null, decimals: number): string {
  if (value === null) return '—';
  const numeric = Number(value);
  return `$${numeric.toFixed(dynamicDecimals(numeric, decimals))}`;
}

export type PercentDirection = 'up' | 'down' | 'flat';

// text is unsigned — the caller renders a ▲/▼ for direction (see PercentChange in launch-list.tsx)
// instead of a +/- sign, matching the reference UI, so direction is reported separately.
export function formatPercent(value: string | null): { text: string; className: string; direction: PercentDirection } {
  if (value === null) return { text: '—', className: 'text-muted-foreground', direction: 'flat' };
  const numeric = Number(value);
  const rounded = Math.abs(numeric).toFixed(2);
  if (numeric > 0) return { text: `${rounded}%`, className: 'text-emerald-600', direction: 'up' };
  if (numeric < 0) return { text: `${rounded}%`, className: 'text-red-600', direction: 'down' };
  return { text: `${rounded}%`, className: 'text-muted-foreground', direction: 'flat' };
}

// A near-realtime-synced launch is visible before its core metadata (name/symbol/decimals) resolves —
// the UI shows the token address as the name fallback rather than hiding the row or inventing a label.
export function displayName(name: string | null, tokenAddress: string): string {
  return name ?? tokenAddress;
}

export function displaySymbol(symbol: string | null): string {
  return symbol ?? '—';
}

export function tvlTooltip(value: {
  tvlBasis: string | null;
  tvlUnavailableReason: string | null;
  tvlPriceSource: string | null;
  tvlPriceUpdatedAt: number | null;
}): string {
  if (value.tvlUnavailableReason === 'quote_price_unavailable') return 'TVL unavailable: no current trusted USD price for this quote asset.';
  if (value.tvlUnavailableReason) return 'TVL unavailable: current on-chain venue data is incomplete.';
  const basis = value.tvlBasis === 'curve_real_quote'
    ? 'Value of the real quote reserve in the bonding curve; excludes virtual reserves and unsold launch tokens.'
    : 'Market value of both tokens held as liquidity in the pool.';
  if (value.tvlPriceSource === 'chainlink' && value.tvlPriceUpdatedAt !== null) {
    return `${basis} Quote USD price: Chainlink oracle, updated ${new Date(value.tvlPriceUpdatedAt * 1000).toISOString()}.`;
  }
  return basis;
}

export function formatSide(side: string): string {
  if (side === 'buy') return 'Buy';
  if (side === 'sell') return 'Sell';
  return side;
}

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  protocol_buyback: 'Buyback by Pons',
  protocol_fee_conversion: 'Fee conversion by Pons',
  protocol_internal: 'Internal Pons transaction',
};

// Returns null for an ordinary user trade: callers fall back to formatSide instead of
// implying the trade was placed by the user's own wallet.
export function formatActivityKind(activityKind: string): string | null {
  return ACTIVITY_KIND_LABELS[activityKind] ?? null;
}

const LIFECYCLE_STATUS_LABELS: Record<string, string> = {
  trading: 'Trading',
  swept: 'Swept',
  graduated: 'Graduated',
  rescued: 'Rescued',
};

export function formatLifecycleStatus(status: string): string {
  return LIFECYCLE_STATUS_LABELS[status] ?? status;
}

const VENUE_KIND_LABELS: Record<string, string> = {
  curve: 'Bonding curve',
  v3_pool: 'Uniswap V3 Pool',
  v4_pool: 'Uniswap V4 Pool',
};

export function formatVenueKind(kind: string): string {
  return VENUE_KIND_LABELS[kind] ?? kind;
}

const COVERAGE_STATUS_LABELS: Record<string, string> = {
  caught_up: 'Caught up',
  backfilling: 'Backfilling',
  degraded: 'Degraded',
};

export function formatCoverageStatus(status: string): string {
  return COVERAGE_STATUS_LABELS[status] ?? status;
}

// The only place price/volume decimal strings are converted with Number(): Lightweight Charts
// requires numeric OHLC values, so this boundary conversion happens once, at chart render time.
export function toChartValue(value: string): number {
  return Number(value);
}

const DEFAULT_CHART_PRICE_FORMAT = { precision: 2, minMove: 0.01 };

// Lightweight Charts' default price format (precision 2) rounds pons-scale prices like
// 0.000000152 to 0.00, making the chart axis meaningless. Derive enough decimal digits from
// the actual data instead, at the same render boundary as toChartValue.
export function computeChartPrecision(values: readonly string[]): { precision: number; minMove: number } {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length === 0) return DEFAULT_CHART_PRICE_FORMAT;
  const min = Math.min(...numbers);
  if (min >= 1) return DEFAULT_CHART_PRICE_FORMAT;
  const magnitude = Math.floor(Math.log10(min));
  const precision = Math.max(2, -magnitude + 2);
  return { precision, minMove: 10 ** -precision };
}
