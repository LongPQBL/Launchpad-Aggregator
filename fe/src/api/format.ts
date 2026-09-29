export function formatQuote(value: string | null, symbol: string): string {
  if (value === null) return 'Chưa có dữ liệu';
  return `${value} ${symbol}`;
}
