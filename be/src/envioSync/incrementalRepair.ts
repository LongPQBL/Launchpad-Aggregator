import type { Pool } from 'pg';
import { and, eq, inArray, isNull, gte, sql } from 'drizzle-orm';
import type { Database, DbOrTx } from '../db/client.js';
import { launches, venues, trades, lifecycleTransitions, envioRepairState } from '../db/schema.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { readRawWindowKeys, type CanonicalEventKey } from './incrementalPage.js';
import { advanceSyncCursor, claimSyncCursor, LANES, type Stream } from './incrementalCursor.js';
import { DEFAULT_STREAM_TABLES, STREAM_ORDER } from './incrementalSync.js';
import { notifyChanged } from './notifyChanges.js';

const v1SourceIds = getPonsFactorySources().filter((factory) => factory.version === 'v1').map((factory) => factory.id);
const v2Factory = getPonsFactorySources()[2]!;

export interface RepairInput {
  chainId: number;
  fence: bigint;
  depth: bigint;
  tables?: Partial<Record<Stream, string>>;
}
export interface RepairReport {
  changedLaunchKeys: { chainId: number; tokenAddress: string }[];
}

interface AppKeyedRow extends CanonicalEventKey { tokenAddress: string }

/** Keys present in `appRows` that no longer match Envio's current canonical set — stale, needs removal. */
function staleAppRows(envioKeys: readonly CanonicalEventKey[], appRows: readonly AppKeyedRow[]): AppKeyedRow[] {
  const envioByKey = new Map(envioKeys.map((key) => [`${key.txHash}:${key.logIndex}`, key.blockHash]));
  return appRows.filter((row) => envioByKey.get(`${row.txHash}:${row.logIndex}`) !== row.blockHash);
}

// ---- v1-launch / v2-launch: one row per token; a stale key means the whole launch is wrong and
// must be deleted (cascades to its venues and, through those, its trades — see schema.ts's FKs). ----
async function appLaunchWindow(tx: DbOrTx, chainId: number, sourceIds: readonly string[], windowStart: bigint): Promise<AppKeyedRow[]> {
  const rows = await tx.select({
    txHash: launches.launchTxHash, logIndex: launches.launchLogIndex, blockHash: launches.launchBlockHash, tokenAddress: launches.tokenAddress,
  }).from(launches).where(and(
    eq(launches.chainId, chainId), inArray(launches.sourceId, sourceIds), isNull(launches.sourceLogId), gte(launches.launchBlock, windowStart),
  ));
  return rows.filter((row): row is AppKeyedRow => row.blockHash !== null)
    .map((row) => ({ txHash: row.txHash.toLowerCase(), logIndex: row.logIndex, blockHash: row.blockHash.toLowerCase(), tokenAddress: row.tokenAddress }));
}
async function deleteLaunches(tx: DbOrTx, chainId: number, tokenAddresses: readonly string[]): Promise<void> {
  if (tokenAddresses.length === 0) return;
  await tx.delete(launches).where(and(eq(launches.chainId, chainId), inArray(launches.tokenAddress, tokenAddresses)));
}

// ---- v1-swap / v2-curve / v2-buyback / v4-swap: trades, individually keyed by (chainId, txHash, logIndex).
// `sourceEvents` scopes the diff to the rows this one raw stream actually owns — curve and buyback
// trades share the same 'curve'-kind venue, so without it, each stream's diff would see the other's
// rows as absent from its own raw table and delete them as "stale", wiping both every repair pass
// (final review, Important 6). ----
async function appTradeWindow(
  tx: DbOrTx, chainId: number, venueKinds: readonly string[], sourceEvents: readonly string[], windowStart: bigint,
): Promise<AppKeyedRow[]> {
  const venueIds = tx.select({ id: venues.id }).from(venues).where(inArray(venues.kind, venueKinds));
  const rows = await tx.select({ txHash: trades.txHash, logIndex: trades.logIndex, blockHash: trades.blockHash, tokenAddress: trades.tokenAddress })
    .from(trades).where(and(
      eq(trades.chainId, chainId), inArray(trades.venueId, venueIds), inArray(trades.sourceEvent, sourceEvents),
      isNull(trades.sourceLogId), gte(trades.blockNumber, windowStart),
    ));
  return rows.map((row) => ({ txHash: row.txHash.toLowerCase(), logIndex: row.logIndex, blockHash: row.blockHash.toLowerCase(), tokenAddress: row.tokenAddress }));
}
async function deleteTrades(tx: DbOrTx, chainId: number, keys: readonly AppKeyedRow[]): Promise<void> {
  for (const key of keys) {
    await tx.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, key.txHash), eq(trades.logIndex, key.logIndex)));
  }
}

// ---- v2-lifecycle: individually keyed by (chainId, txHash, logIndex); removing one also closes
// the token's v4_pool venue if its graduation was the one removed (see repairV4InitializeCascade). ----
async function appLifecycleWindow(tx: DbOrTx, chainId: number, windowStart: bigint): Promise<AppKeyedRow[]> {
  const rows = await tx.select({
    txHash: lifecycleTransitions.txHash, logIndex: lifecycleTransitions.logIndex, blockHash: lifecycleTransitions.blockHash,
    tokenAddress: lifecycleTransitions.tokenAddress,
  }).from(lifecycleTransitions).where(and(
    eq(lifecycleTransitions.chainId, chainId), eq(lifecycleTransitions.sourceId, 'pons-v2-lifecycle'),
    isNull(lifecycleTransitions.sourceLogId), gte(lifecycleTransitions.blockNumber, windowStart),
  ));
  return rows.map((row) => ({ txHash: row.txHash.toLowerCase(), logIndex: row.logIndex, blockHash: row.blockHash.toLowerCase(), tokenAddress: row.tokenAddress }));
}
async function deleteLifecycleTransitions(tx: DbOrTx, chainId: number, keys: readonly AppKeyedRow[]): Promise<void> {
  for (const key of keys) {
    await tx.delete(lifecycleTransitions).where(and(
      eq(lifecycleTransitions.chainId, chainId), eq(lifecycleTransitions.txHash, key.txHash), eq(lifecycleTransitions.logIndex, key.logIndex),
    ));
  }
  // A graduated launch whose only graduation transition just vanished returns to 'trading' — the
  // same rule the full-table reorgGuard.ts path applies (see runSyncV2.ts's post-reconcile rebuild).
  const tokens = [...new Set(keys.map((key) => key.tokenAddress))];
  for (const tokenAddress of tokens) {
    await tx.execute(sql`UPDATE launches AS l SET lifecycle_status = COALESCE((
        SELECT CASE t.phase WHEN 1 THEN 'swept' WHEN 2 THEN 'graduated' WHEN 3 THEN 'rescued' END
        FROM lifecycle_transitions AS t WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address
        ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1
      ), 'trading') WHERE l.chain_id = ${chainId} AND l.token_address = ${tokenAddress} AND l.source_id = ${v2Factory.id}`);
  }
}

// ---- v4-initialize: the opened venue itself carries no raw event identity (venues has no
// txHash/blockHash column — see schema.ts). Its correctness is entirely conditioned on the specific
// 'graduated' transition that opened it still existing, so it is repaired as a cascade from
// v2-lifecycle's own removal, keyed by token, not by a separate event-key diff. ----
async function repairV4InitializeCascade(tx: DbOrTx, chainId: number, removedLifecycleTokens: readonly string[]): Promise<string[]> {
  if (removedLifecycleTokens.length === 0) return [];
  const stillGraduated = await tx.select({ tokenAddress: lifecycleTransitions.tokenAddress }).from(lifecycleTransitions)
    .where(and(eq(lifecycleTransitions.chainId, chainId), eq(lifecycleTransitions.kind, 'graduated'),
      inArray(lifecycleTransitions.tokenAddress, removedLifecycleTokens)));
  const stillGraduatedSet = new Set(stillGraduated.map((row) => row.tokenAddress));
  const orphaned = removedLifecycleTokens.filter((token) => !stillGraduatedSet.has(token));
  if (orphaned.length === 0) return [];
  await tx.delete(venues).where(and(eq(venues.chainId, chainId), eq(venues.kind, 'v4_pool'), inArray(venues.tokenAddress, orphaned)));
  return orphaned;
}

// Rewinds every lane whose position already read past windowStart, so the next regular pass
// re-reads and re-applies this stream's corrected window. `staleFound` applies to both lanes
// uniformly (either one may have already read the now-stale rows); a per-lane Envio rollback
// (this lane's own recorded watermark now exceeds the current fence) is checked independently,
// since tail and history advance at different rates and only one may actually be affected.
async function rewindStreamCursors(tx: DbOrTx, chainId: number, stream: Stream, windowStart: bigint, fence: bigint, staleFound: boolean): Promise<void> {
  for (const lane of LANES) {
    const key = { chainId, stream, lane };
    const cursor = await claimSyncCursor(tx, key);
    const laneRolledBack = fence < (cursor.processedWatermark ?? 0n);
    if ((staleFound || laneRolledBack) && cursor.position.blockNumber > windowStart) {
      await advanceSyncCursor(tx, key, { blockNumber: windowStart, logIndex: -1, rawId: '' }, windowStart);
    }
  }
}

/**
 * Compares Envio's current canonical event keys against the app's own Envio-derived rows in the
 * provisional window (the last `depth` blocks before `fence`), removes only the rows that no longer
 * match (same position, different block — a reorg replacement — or gone entirely), and rewinds the
 * affected stream's cursors so the next regular sync pass re-reads and re-applies the correct data.
 * Old-indexer rows (non-null sourceLogId) are never touched. Runs as one transaction across all
 * streams in dependency order.
 */
export async function repairEnvioWindow(envioPool: Pool, appDb: Database, input: RepairInput): Promise<RepairReport> {
  const tables = { ...DEFAULT_STREAM_TABLES, ...input.tables };
  const windowStart = input.fence > input.depth ? input.fence - input.depth : 0n;
  const changed = new Map<string, { chainId: number; tokenAddress: string }>();

  // A launch/venue deletion here cascades (via FK) to rows another stream's OWN diff owns — that
  // stream then sees those rows as simply gone, not "mismatched", and never flags them stale on its
  // own. Without forcing its rewind too, its cursor stays put and the cascaded-away data is never
  // re-read or re-applied — a permanent loss, not a delay (final review, Important 7).
  const cascadeRewind = new Set<Stream>();

  await appDb.transaction(async (tx) => {
    let removedLifecycleTokens: string[] = [];
    for (const stream of STREAM_ORDER) {
      let staleTokens: string[] = [];
      switch (stream) {
        case 'v1-launch': {
          const envioKeys = await readRawWindowKeys(envioPool, tables['v1-launch'], input.chainId, windowStart, input.fence);
          const appRows = await appLaunchWindow(tx, input.chainId, v1SourceIds, windowStart);
          const stale = staleAppRows(envioKeys, appRows);
          await deleteLaunches(tx, input.chainId, stale.map((row) => row.tokenAddress));
          staleTokens = stale.map((row) => row.tokenAddress);
          if (staleTokens.length > 0) cascadeRewind.add('v1-swap');
          break;
        }
        case 'v1-swap': {
          const envioKeys = await readRawWindowKeys(envioPool, tables['v1-swap'], input.chainId, windowStart, input.fence);
          const appRows = await appTradeWindow(tx, input.chainId, ['v3_pool'], ['Swap'], windowStart);
          const stale = staleAppRows(envioKeys, appRows);
          await deleteTrades(tx, input.chainId, stale);
          staleTokens = stale.map((row) => row.tokenAddress);
          break;
        }
        case 'v2-launch': {
          const envioKeys = await readRawWindowKeys(envioPool, tables['v2-launch'], input.chainId, windowStart, input.fence);
          const appRows = await appLaunchWindow(tx, input.chainId, [v2Factory.id], windowStart);
          const stale = staleAppRows(envioKeys, appRows);
          await deleteLaunches(tx, input.chainId, stale.map((row) => row.tokenAddress));
          staleTokens = stale.map((row) => row.tokenAddress);
          if (staleTokens.length > 0) {
            for (const downstream of ['v2-curve', 'v2-buyback', 'v2-lifecycle', 'v4-initialize', 'v4-swap'] as const) cascadeRewind.add(downstream);
          }
          break;
        }
        case 'v2-curve':
        case 'v2-buyback': {
          const sourceEvents = stream === 'v2-curve' ? ['CurveBuy', 'CurveSell'] : ['BuybackLocked'];
          const envioKeys = await readRawWindowKeys(envioPool, tables[stream], input.chainId, windowStart, input.fence);
          const appRows = await appTradeWindow(tx, input.chainId, ['curve'], sourceEvents, windowStart);
          const stale = staleAppRows(envioKeys, appRows);
          await deleteTrades(tx, input.chainId, stale);
          staleTokens = stale.map((row) => row.tokenAddress);
          break;
        }
        case 'v2-lifecycle': {
          const envioKeys = await readRawWindowKeys(envioPool, tables['v2-lifecycle'], input.chainId, windowStart, input.fence);
          const appRows = await appLifecycleWindow(tx, input.chainId, windowStart);
          const stale = staleAppRows(envioKeys, appRows);
          await deleteLifecycleTransitions(tx, input.chainId, stale);
          staleTokens = stale.map((row) => row.tokenAddress);
          removedLifecycleTokens = staleTokens;
          break;
        }
        case 'v4-initialize': {
          staleTokens = await repairV4InitializeCascade(tx, input.chainId, removedLifecycleTokens);
          if (staleTokens.length > 0) cascadeRewind.add('v4-swap');
          break;
        }
        case 'v4-swap': {
          const envioKeys = await readRawWindowKeys(envioPool, tables['v4-swap'], input.chainId, windowStart, input.fence);
          const appRows = await appTradeWindow(tx, input.chainId, ['v4_pool'], ['Swap'], windowStart);
          const stale = staleAppRows(envioKeys, appRows);
          await deleteTrades(tx, input.chainId, stale);
          staleTokens = stale.map((row) => row.tokenAddress);
          break;
        }
      }
      for (const tokenAddress of staleTokens) changed.set(`${input.chainId}:${tokenAddress}`, { chainId: input.chainId, tokenAddress });
      await rewindStreamCursors(tx, input.chainId, stream, windowStart, input.fence, staleTokens.length > 0 || cascadeRewind.has(stream));
    }
    // Inside the same transaction so delivery only happens after the repair actually commits.
    await notifyChanged(tx, [...changed.values()].map((key) => ({ kind: 'launch.changed' as const, ...key })));
  });

  return { changedLaunchKeys: [...changed.values()] };
}

/** Records a repair attempt's outcome — see schema.ts's envioRepairState: the coverage API reads this so a silently-failing repair worker is observable, not only visible in CLI logs. */
export async function recordRepairOutcome(appDb: Database, chainId: number, now: Date, error: unknown): Promise<void> {
  if (error === null) {
    await appDb.insert(envioRepairState).values({ chainId, lastRunAt: now, lastSuccessAt: now })
      .onConflictDoUpdate({ target: envioRepairState.chainId, set: { lastRunAt: now, lastSuccessAt: now } });
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  await appDb.insert(envioRepairState).values({ chainId, lastRunAt: now, lastFailureAt: now, lastFailureReason: reason, failureCount: 1 })
    .onConflictDoUpdate({
      target: envioRepairState.chainId,
      set: { lastRunAt: now, lastFailureAt: now, lastFailureReason: reason, failureCount: sql`${envioRepairState.failureCount} + 1` },
    });
}

export interface RepairState {
  lastRunAt: Date | null; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastFailureReason: string | null; failureCount: number;
}
const EMPTY_REPAIR_STATE: RepairState = { lastRunAt: null, lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, failureCount: 0 };

export async function readRepairState(pool: Pool, chainId: number): Promise<RepairState> {
  const result = await pool.query(
    'SELECT last_run_at, last_success_at, last_failure_at, last_failure_reason, failure_count FROM envio_repair_state WHERE chain_id = $1',
    [chainId],
  );
  const row = result.rows[0] as { last_run_at: Date | null; last_success_at: Date | null; last_failure_at: Date | null;
    last_failure_reason: string | null; failure_count: number } | undefined;
  if (!row) return EMPTY_REPAIR_STATE;
  return {
    lastRunAt: row.last_run_at, lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at,
    lastFailureReason: row.last_failure_reason, failureCount: row.failure_count,
  };
}
