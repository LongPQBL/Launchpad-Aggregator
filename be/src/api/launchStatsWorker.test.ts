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
});
