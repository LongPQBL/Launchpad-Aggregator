import { and, gte, inArray, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
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
  launchSourceIds?: string[];
  transitionSourceIds?: string[];
}

// Only Envio-derived real rows have null sourceLogId. RPC-indexer rows retain their raw-log FK
// and must survive even when Envio has not yet rescanned their block range. Each protocol sync
// scopes its own venue KIND (v3_pool / curve / v4_pool) so its reconciliation cannot erase another
// protocol's fresh writes.
//
// Deliberately NOT filtered by venues.sourceId: a venue row is shared between the RPC indexer and
// Envio (same deterministic venueKey, onConflictDoNothing on insert), so an existing token's venue
// almost always carries the RPC indexer's own sourceId ('pons-v1-legacy', 'pons-v2', etc.), not an
// Envio one — a sourceId-pattern filter here would make every Envio trade on a pre-existing token
// invisible to reorg reconciliation (found by the final review's reproduction, Critical 1). The
// `isNull(sourceLogId)` guard on trades/venues themselves is what keeps this safe: it already
// guarantees only Envio-written rows are ever deleted, regardless of which protocol created the
// venue they're attached to.
export async function reconcileReorgWindow(
  appDb: DbOrTx, tables: ReorgTargetTables, windowStart: bigint, scope: ReorgScope = {},
): Promise<void> {
  if (tables.launches === launches) {
    if (!scope.venueKinds?.length) {
      throw new Error('Real-table reorg reconciliation requires an explicit venue-kind scope');
    }
    const venueIds = appDb.select({ id: venues.id }).from(venues).where(inArray(venues.kind, scope.venueKinds));
    await appDb.delete(trades).where(and(gte(trades.blockNumber, windowStart), isNull(trades.sourceLogId), inArray(trades.venueId, venueIds)));
    if (tables.lifecycleTransitions && scope.transitionSourceIds?.length) {
      await appDb.delete(lifecycleTransitions).where(and(gte(lifecycleTransitions.blockNumber, windowStart),
        isNull(lifecycleTransitions.sourceLogId), inArray(lifecycleTransitions.sourceId, scope.transitionSourceIds)));
    }
    await appDb.delete(venues).where(and(gte(venues.effectiveFromBlock, windowStart), isNull(venues.sourceLogId),
      inArray(venues.kind, scope.venueKinds)));
    if (scope.launchSourceIds?.length) {
      await appDb.delete(launches).where(and(gte(launches.launchBlock, windowStart), isNull(launches.sourceLogId),
        inArray(launches.sourceId, scope.launchSourceIds)));
    }
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
