import type { Pool, PoolClient } from 'pg';
import { isAddress } from 'viem';
import { ApiEventBus, type ApiEvent } from './events.js';

const eventNames = new Set(['launch.changed', 'trade.created', 'coverage.changed']);

export function parseDatabaseEvent(payload: string): ApiEvent | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const event = value as Record<string, unknown>;
    if (typeof event.type !== 'string' || !eventNames.has(event.type)
      || typeof event.chainId !== 'number' || !Number.isSafeInteger(event.chainId) || event.chainId <= 0
      || (event.tokenAddress !== undefined && (typeof event.tokenAddress !== 'string' || !isAddress(event.tokenAddress)))) return null;
    return { type: event.type as ApiEvent['type'], chainId: event.chainId,
      ...(typeof event.tokenAddress === 'string' ? { tokenAddress: event.tokenAddress.toLowerCase() } : {}) };
  } catch { return null; }
}

async function connectAndListen(pool: Pool, onNotification: (message: { channel: string; payload?: string }) => void): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query('LISTEN launchpad_events');
  } catch (error) {
    client.release(true);
    throw error;
  }
  client.on('notification', onNotification);
  return client;
}

const RECONNECT_DELAY_MS = 1000;

/**
 * Bridges Postgres NOTIFY on `launchpad_events` into the in-process event bus. The initial connect
 * failing still throws (same as before — the API process shouldn't start half-wired). Once connected,
 * a dropped session (network blip, Postgres restart) is resumed automatically after a short delay —
 * a notification missed during that gap is why the frontend also polls at a low rate as a backstop
 * (see fe/src/api/client.ts), not relied on to be gapless.
 */
export async function listenForDatabaseEvents(pool: Pool, bus: ApiEventBus): Promise<() => Promise<void>> {
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const onNotification = (message: { channel: string; payload?: string }) => {
    if (message.channel !== 'launchpad_events' || !message.payload) return;
    const event = parseDatabaseEvent(message.payload);
    if (event) bus.publish(event);
  };

  // A plain `let client` reassigned inside reconnect() would not be visible to the closures captured
  // before that reassignment (attachErrorHandler's onError, and the returned stop() below) — each
  // would keep referencing whichever client existed when it was created. A holder object instead has
  // exactly one `.current`, so stop() and every future onError see the latest live connection.
  const holder: { current: PoolClient } = { current: await connectAndListen(pool, onNotification) };

  function attachErrorHandler(target: PoolClient): void {
    const onError = () => {
      target.removeListener('notification', onNotification);
      target.removeListener('error', onError);
      target.release(true);
      if (stopped) return;
      reconnectTimer = setTimeout(() => { void reconnect(); }, RECONNECT_DELAY_MS);
    };
    target.on('error', onError);
  }

  async function reconnect(): Promise<void> {
    if (stopped) return;
    try {
      holder.current = await connectAndListen(pool, onNotification);
      attachErrorHandler(holder.current);
    } catch {
      reconnectTimer = setTimeout(() => { void reconnect(); }, RECONNECT_DELAY_MS);
    }
  }

  attachErrorHandler(holder.current);

  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    holder.current.removeAllListeners('notification');
    holder.current.removeAllListeners('error');
    try { await holder.current.query('UNLISTEN launchpad_events'); } catch { /* connection may already be dead */ }
    holder.current.release();
  };
}
