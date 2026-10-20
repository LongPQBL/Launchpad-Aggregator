import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { refreshLaunchStatsOnce } from './launchStatsWorker.js';

describe('refreshLaunchStatsOnce', () => {
  it('reports only rows actually refreshed when coverage is incomplete', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ safe_head: '100' }] })
      .mockResolvedValueOnce({ rows: [{ chain_id: 4663, token_address: '0x1', launch_coverage_complete: false, stats_computed_at: null }] });
    const pool = { query } as unknown as Pool;

    await expect(refreshLaunchStatsOnce(pool, {} as never, 1, new Date())).resolves.toBe(0);
  });

  it('only selects launches whose coverage is complete in every pass, so incomplete newest launches cannot starve older ones', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe_head: '100' }] });
    const pool = { query } as unknown as Pool;

    await refreshLaunchStatsOnce(pool, {} as never, 8, new Date());

    const selections = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('FROM launch') && sql.includes('LIMIT'));
    expect(selections.length).toBeGreaterThanOrEqual(3);
    for (const sql of selections) {
      // the coverage expression is part of the WHERE clause, not only of the selected columns
      const where = sql.slice(sql.indexOf('WHERE'));
      expect(where).toContain('fast_lane_state');
    }
  });
});
