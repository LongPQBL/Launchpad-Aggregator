import type { Time } from 'lightweight-charts';

// What the library labels a tick as: a year or month boundary, a day boundary, or a time of day.
const YEAR = 0;
const MONTH = 1;
const DAY_OF_MONTH = 2;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Time-axis labels the way Uniswap writes them, in UTC like the rest of the chart: "12:00" inside a day, "Oct 14" at a day
 * boundary, "Oct" at a month boundary, "2026" at a year boundary. The library's own default prints a bare "14" for a day.
 */
export function formatTimeAxisTick(time: Time, tickMarkType: number): string | null {
  if (typeof time !== 'number') return null;
  const date = new Date(time * 1000);
  switch (tickMarkType) {
    case YEAR: return String(date.getUTCFullYear());
    case MONTH: return MONTHS[date.getUTCMonth()]!;
    case DAY_OF_MONTH: return `${MONTHS[date.getUTCMonth()]!} ${date.getUTCDate()}`;
    default: return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }
}
