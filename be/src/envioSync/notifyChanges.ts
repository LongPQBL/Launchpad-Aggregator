import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';

export type ChangeKind = 'launch.changed' | 'trade.created' | 'coverage.changed';
export interface ChangeNotification { kind: ChangeKind; chainId: number; tokenAddress?: string }

/**
 * Publishes compact `launchpad_events` notifications via `pg_notify`, called from inside the same
 * app-DB transaction as the commit it reports — delivery to a LISTEN-ing session only ever happens
 * after that transaction actually commits; a rollback sends nothing. Repeated changes for the same
 * (kind, chainId, tokenAddress) within one call collapse into a single notification, matching
 * be/src/api/pgEvents.ts's parseDatabaseEvent wire format (`type`, not `kind`).
 */
export async function notifyChanged(tx: DbOrTx, changes: readonly ChangeNotification[]): Promise<void> {
  const seen = new Map<string, ChangeNotification>();
  for (const change of changes) {
    const tokenKey = change.tokenAddress?.toLowerCase() ?? '';
    seen.set(`${change.kind}:${change.chainId}:${tokenKey}`, change);
  }
  for (const change of seen.values()) {
    const payload = JSON.stringify({
      type: change.kind, chainId: change.chainId,
      ...(change.tokenAddress ? { tokenAddress: change.tokenAddress.toLowerCase() } : {}),
    });
    await tx.execute(sql`SELECT pg_notify('launchpad_events', ${payload})`);
  }
}
