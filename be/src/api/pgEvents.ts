import type { Pool } from 'pg';
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

export async function listenForDatabaseEvents(pool: Pool, bus: ApiEventBus): Promise<() => Promise<void>> {
  const client = await pool.connect();
  const onNotification = (message: { channel: string; payload?: string }) => {
    if (message.channel !== 'launchpad_events' || !message.payload) return;
    const event = parseDatabaseEvent(message.payload);
    if (event) bus.publish(event);
  };
  try {
    await client.query('LISTEN launchpad_events');
    client.on('notification', onNotification);
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    client.removeListener('notification', onNotification);
    await client.query('UNLISTEN launchpad_events');
    client.release();
  };
}
