import { describe, expect, it } from 'vitest';
import { formatTimeAxisTick } from './time-axis';

const at = (iso: string) => Date.parse(iso) / 1000 as never;

describe('formatTimeAxisTick', () => {
  it('writes a time of day as HH:mm in UTC', () => {
    expect(formatTimeAxisTick(at('2026-10-14T06:05:00Z'), 3)).toBe('06:05');
  });
  it('writes a day boundary as month and day, not a bare number', () => {
    expect(formatTimeAxisTick(at('2026-10-14T00:00:00Z'), 2)).toBe('Oct 14');
  });
  it('writes month and year boundaries', () => {
    expect(formatTimeAxisTick(at('2026-11-01T00:00:00Z'), 1)).toBe('Nov');
    expect(formatTimeAxisTick(at('2027-01-01T00:00:00Z'), 0)).toBe('2027');
  });
  it('leaves a business-day time to the library', () => {
    expect(formatTimeAxisTick('2026-10-14', 2)).toBeNull();
  });
});
