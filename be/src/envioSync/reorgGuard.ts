import { and, desc, eq, gte, inArray, isNull, like } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  launches, venues, trades, lifecycleTransitions,
  launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging,
} from '../db/schema.js';

export interface ReorgTargetTables {
  launches: typeof launches | typeof launchesEnvioStaging;
  venues: typeof venues | typeof venuesEnvioStaging;
  trades: typeof trades | typeof tradesEnvioStaging;
  lifecycleTransitions?: typeof lifecycleTransitions | typeof lifecycleTransitionsEnvioStaging;
}

export interface ReorgScope {
  venueKinds?: string[];
  venueSourceIdPattern?: string;
  launchSourceIds?: string[];
  transitionSourceIds?: string[];
}

// Only Envio-derived real rows have null sourceLogId. RPC-indexer rows retain their raw-log FK
// and must survive even when Envio has not yet rescanned their block range. Each protocol sync
// scopes its own venues so its reconciliation cannot erase another protocol's fresh writes.
export async function reconcileReorgWindow(
  appDb: Database, tables: ReorgTargetTables, windowStart: bigint, scope: ReorgScope = {},
): Promise<void> {
  if (tables.launches === launches) {
    if (!scope.venueKinds?.length || !scope.venueSourceIdPattern || !scope.launchSourceIds?.length) {
      throw new Error('Real-table reorg reconciliation requires an explicit source scope');
    }
    const venueIds = appDb.select({ id: venues.id }).from(venues).where(and(
      inArray(venues.kind, scope.venueKinds), like(venues.sourceId, scope.venueSourceIdPattern),
    ));
    await appDb.delete(trades).where(and(gte(trades.blockNumber, windowStart), isNull(trades.sourceLogId), inArray(trades.venueId, venueIds)));
    if (tables.lifecycleTransitions && scope.transitionSourceIds?.length) {
      await appDb.delete(lifecycleTransitions).where(and(gte(lifecycleTransitions.blockNumber, windowStart),
        isNull(lifecycleTransitions.sourceLogId), inArray(lifecycleTransitions.sourceId, scope.transitionSourceIds)));
    }
    await appDb.delete(venues).where(and(gte(venues.effectiveFromBlock, windowStart), isNull(venues.sourceLogId),
      inArray(venues.kind, scope.venueKinds), like(venues.sourceId, scope.venueSourceIdPattern)));
    await appDb.delete(launches).where(and(gte(launches.launchBlock, windowStart), isNull(launches.sourceLogId),
      inArray(launches.sourceId, scope.launchSourceIds)));
    return;
  }
  const stagingVenueIds = appDb.select({ id: venuesEnvioStaging.id }).from(venuesEnvioStaging)
    .where(scope.venueKinds?.length ? inArray(venuesEnvioStaging.kind, scope.venueKinds) : undefined);
  await appDb.delete(tradesEnvioStaging).where(and(gte(tradesEnvioStaging.blockNumber, windowStart),
    inArray(tradesEnvioStaging.venueId, stagingVenueIds)));
  if (tables.lifecycleTransitions) {
    await appDb.delete(lifecycleTransitionsEnvioStaging).where(gte(lifecycleTransitionsEnvioStaging.blockNumber, windowStart));
  }
  await appDb.delete(venuesEnvioStaging).where(and(gte(venuesEnvioStaging.effectiveFromBlock, windowStart),
    scope.venueKinds?.length ? inArray(venuesEnvioStaging.kind, scope.venueKinds) : undefined));
  await appDb.delete(launchesEnvioStaging).where(gte(launchesEnvioStaging.launchBlock, windowStart));
}

// Tracks only Envio-derived trades. An old RPC trade can be far ahead of Envio's raw scan
// and must not move the reorg window past data Envio can rebuild.
export async function currentMaxBlock(appDb: Database, venueSourceIdPattern: string): Promise<bigint | null> {
  const rows = await appDb.select({ blockNumber: trades.blockNumber }).from(trades)
    .innerJoin(venues, eq(trades.venueId, venues.id))
    .where(and(like(venues.sourceId, venueSourceIdPattern), isNull(trades.sourceLogId)))
    .orderBy(desc(trades.blockNumber)).limit(1);
  return rows[0]?.blockNumber ?? null;
}
