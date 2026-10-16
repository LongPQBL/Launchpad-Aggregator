import { describe, expect, it } from 'vitest';
import { expireMarketStats, MARKET_STATS_MAX_AGE_MS } from './launchStatsStore.js';
import type { StatsFields } from './store.js';

const stats = { fdvUsd: '5', marketCapUsd: '5', priceUsd: '1', week52High: '2', week52Low: '0.5', week52HighUsd: '2', week52LowUsd: '0.5', change1h: '1', change1d: '2', tvlUsd: '9', tvlBasis: 'x', tvlBlockNumber: '1' } as unknown as StatsFields;
const now = new Date('2026-10-15T12:00:00Z');

describe('expireMarketStats', () => {
  it('keeps fresh stats', () => {
    expect(expireMarketStats(stats, new Date(now.getTime() - 1000), now)).toBe(stats);
  });
  it('blanks market figures but keeps the 52-week range when old', () => {
    const old = expireMarketStats(stats, new Date(now.getTime() - MARKET_STATS_MAX_AGE_MS - 1), now);
    expect(old.priceUsd).toBeNull();
    expect(old.fdvUsd).toBeNull();
    expect(old.tvlUsd).toBeNull();
    expect(old.change1d).toBeNull();
    expect(old.week52High).toBe('2');
    expect(old.week52LowUsd).toBe('0.5');
  });
});
