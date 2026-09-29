export function formatQuote(value: string | null, symbol: string): string {
  if (value === null) return 'Chưa có dữ liệu';
  return `${value} ${symbol}`;
}

export function formatSide(side: string): string {
  if (side === 'buy') return 'Mua';
  if (side === 'sell') return 'Bán';
  return side;
}

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  protocol_buyback: 'Buyback bởi Pons',
  protocol_fee_conversion: 'Đổi phí bởi Pons',
  protocol_internal: 'Giao dịch nội bộ Pons',
};

// Returns null for an ordinary user trade: callers fall back to formatSide instead of
// implying the trade was placed by the user's own wallet.
export function formatActivityKind(activityKind: string): string | null {
  return ACTIVITY_KIND_LABELS[activityKind] ?? null;
}

const LIFECYCLE_STATUS_LABELS: Record<string, string> = {
  trading: 'Đang giao dịch',
  swept: 'Đã gom (Swept)',
  graduated: 'Đã tốt nghiệp',
  rescued: 'Đã cứu hộ (Rescued)',
};

export function formatLifecycleStatus(status: string): string {
  return LIFECYCLE_STATUS_LABELS[status] ?? status;
}

const VENUE_KIND_LABELS: Record<string, string> = {
  curve: 'Bonding curve',
  v3_pool: 'Pool Uniswap V3',
  v4_pool: 'Pool Uniswap V4',
};

export function formatVenueKind(kind: string): string {
  return VENUE_KIND_LABELS[kind] ?? kind;
}

const COVERAGE_STATUS_LABELS: Record<string, string> = {
  caught_up: 'Đã đồng bộ',
  backfilling: 'Đang đồng bộ',
  degraded: 'Đồng bộ gián đoạn',
};

export function formatCoverageStatus(status: string): string {
  return COVERAGE_STATUS_LABELS[status] ?? status;
}

// The only place price/volume decimal strings are converted with Number(): Lightweight Charts
// requires numeric OHLC values, so this boundary conversion happens once, at chart render time.
export function toChartValue(value: string): number {
  return Number(value);
}
