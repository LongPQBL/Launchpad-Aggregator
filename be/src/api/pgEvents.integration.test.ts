import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ApiEventBus, type SequencedApiEvent } from './events.js';
import { listenForDatabaseEvents } from './pgEvents.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const pool = new Pool({ connectionString: databaseUrl });
afterAll(async () => { await pool.end(); });

async function notify(payload: object): Promise<void> {
  await pool.query('SELECT pg_notify($1, $2)', ['launchpad_events', JSON.stringify(payload)]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('listenForDatabaseEvents: reconnection', () => {
  it('resumes receiving notifications after its underlying connection is forcibly dropped', async () => {
    const bus = new ApiEventBus();
    const received: SequencedApiEvent[] = [];
    bus.subscribe((event) => received.push(event));
    const stop = await listenForDatabaseEvents(pool, bus);
    try {
      await notify({ type: 'launch.changed', chainId: 4663, tokenAddress: '0xcccc111111111111111111111111111111111111' });
      await waitFor(() => received.length === 1);
      expect(received).toHaveLength(1);

      // Find and terminate the listener's own backend connection — simulates a real network drop or
      // a Postgres-side restart, not something the listener itself chooses to do.
      const pidResult = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE query = 'LISTEN launchpad_events' AND state = 'idle' ORDER BY backend_start DESC LIMIT 1`,
      );
      const pid = pidResult.rows[0]?.pid;
      expect(pid).toBeDefined();
      await pool.query('SELECT pg_terminate_backend($1)', [pid]);

      // Reconnection runs on a short delay (RECONNECT_DELAY_MS) — give it time, then confirm the
      // bridge is alive again by publishing a second notification.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await notify({ type: 'launch.changed', chainId: 4663, tokenAddress: '0xcccc222222222222222222222222222222222222' });
      await waitFor(() => received.length === 2, 5000);
      expect(received).toHaveLength(2);
      expect(received[1]!.tokenAddress).toBe('0xcccc222222222222222222222222222222222222');
    } finally {
      await stop();
    }
  }, 15000);
});
