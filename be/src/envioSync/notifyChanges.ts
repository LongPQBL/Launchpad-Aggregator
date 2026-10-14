import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';

export type ChangeKind = 'launch.changed' | 'trade.created' | 'coverage.changed' | 'pool.changed';
/** `poolId`/`poolTokens` are set only on `pool.changed`: a swap landed in that pool (any protocol; V4 ids are 32 bytes, V3/V2 20) and these are its two currencies, so a list of one token's pools can pick up a pool it does not show yet. */
export interface ChangeNotification { kind: ChangeKind; chainId: number; tokenAddress?: string; poolId?: string; poolTokens?: readonly string[]; /** Unix seconds of the block that caused it (trade.created, pool.changed): lets the API measure how late it hears of a chain event. */ blockTimestamp?: number; /** Which lane delivered it; absent counts as Envio. */ via?: 'fast' | 'envio' }

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
    seen.set(`${change.kind}:${change.chainId}:${tokenKey}:${change.poolId?.toLowerCase() ?? ''}`, change);
  }
  for (const change of seen.values()) {
    const payload = JSON.stringify({
      type: change.kind, chainId: change.chainId,
      ...(change.tokenAddress ? { tokenAddress: change.tokenAddress.toLowerCase() } : {}),
      ...(change.poolId ? { poolId: change.poolId.toLowerCase() } : {}),
      ...(change.poolTokens?.length ? { poolTokens: change.poolTokens.map((token) => token.toLowerCase()) } : {}),
      ...(change.blockTimestamp !== undefined ? { blockTimestamp: change.blockTimestamp } : {}),
      ...(change.via ? { via: change.via } : {}),
    });
    await tx.execute(sql`SELECT pg_notify('launchpad_events', ${payload})`);
  }
}
