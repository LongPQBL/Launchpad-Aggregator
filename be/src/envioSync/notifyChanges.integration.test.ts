import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createDatabase } from '../db/client.js';
import { notifyChanged } from './notifyChanges.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

const listener = new Client({ connectionString: databaseUrl });
const received: { channel: string; payload?: string }[] = [];

beforeAll(async () => {
  await listener.connect();
  listener.on('notification', (message) => received.push(message));
  await listener.query('LISTEN launchpad_events');
});
afterAll(async () => {
  await listener.query('UNLISTEN launchpad_events');
  await listener.end();
  await pool.end();
});

// pg_notify delivery to a LISTEN-ing session is asynchronous even after commit — give it a moment.
async function waitForNotifications(count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (received.length < count && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('notifyChanged', () => {
  it('delivers a notification only after the transaction commits, never on rollback', async () => {
    received.length = 0;
    await expect(db.transaction(async (tx) => {
      await notifyChanged(tx, [{ kind: 'trade.created', chainId: 4663, tokenAddress: '0xAAAA111111111111111111111111111111111111' }]);
      throw new Error('intentional rollback');
    })).rejects.toThrow('intentional rollback');

    await waitForNotifications(1, 300);
    expect(received).toHaveLength(0);

    await db.transaction(async (tx) => {
      await notifyChanged(tx, [{ kind: 'trade.created', chainId: 4663, tokenAddress: '0xAAAA111111111111111111111111111111111111' }]);
    });
    await waitForNotifications(1);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.payload!)).toEqual({
      type: 'trade.created', chainId: 4663, tokenAddress: '0xaaaa111111111111111111111111111111111111',
    });
  });

  it('coalesces repeated changes for the same token/kind into exactly one notification', async () => {
    received.length = 0;
    await db.transaction(async (tx) => {
      await notifyChanged(tx, [
        { kind: 'launch.changed', chainId: 4663, tokenAddress: '0xBBBB222222222222222222222222222222222222' },
        { kind: 'launch.changed', chainId: 4663, tokenAddress: '0xBBBB222222222222222222222222222222222222' },
        { kind: 'trade.created', chainId: 4663, tokenAddress: '0xBBBB222222222222222222222222222222222222' },
      ]);
    });
    await waitForNotifications(2);
    expect(received).toHaveLength(2);
    const types = received.map((message) => JSON.parse(message.payload!).type).sort();
    expect(types).toEqual(['launch.changed', 'trade.created']);
  });

  it('allows a coverage.changed event with no tokenAddress', async () => {
    received.length = 0;
    await db.transaction(async (tx) => {
      await notifyChanged(tx, [{ kind: 'coverage.changed', chainId: 4663 }]);
    });
    await waitForNotifications(1);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.payload!)).toEqual({ type: 'coverage.changed', chainId: 4663 });
  });

  it('sends one pool.changed per pool, however many swaps landed in it', async () => {
    received.length = 0;
    const a = `0x${'aa'.repeat(32)}`;
    const b = `0x${'bb'.repeat(20)}`;
    await db.transaction(async (tx) => {
      await notifyChanged(tx, [
        { kind: 'pool.changed', chainId: 4663, poolId: a }, { kind: 'pool.changed', chainId: 4663, poolId: a.toUpperCase().replace('0X', '0x') },
        { kind: 'pool.changed', chainId: 4663, poolId: b },
      ]);
    });
    await waitForNotifications(2);
    expect(received.map((m) => JSON.parse(m.payload!)).sort((x, y) => x.poolId.localeCompare(y.poolId)))
      .toEqual([{ type: 'pool.changed', chainId: 4663, poolId: a }, { type: 'pool.changed', chainId: 4663, poolId: b }]);
  });
});
