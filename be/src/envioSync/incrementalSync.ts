import type { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import type { Address, Hash } from 'viem';
import type { Database, DbOrTx } from '../db/client.js';
import type { Launch, LifecycleStatus, Venue, VenueKind } from '../domain/types.js';
import { launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';
import { claimSyncCursor, advanceSyncCursor, STREAMS, type Stream, type Lane, type CursorPosition, type SyncCursor } from './incrementalCursor.js';
import { readRawPage, readRawRowById } from './incrementalPage.js';
import { claimDueUnresolvedEvents, enqueueUnresolvedEvent, settleUnresolvedEvent } from './unresolvedEvents.js';
import { getPonsFactorySources, type FactorySource } from '../launchpads/pons/sourceRegistry.js';
import { hydrateV1Launch } from '../launchpads/pons/v1/adapter.js';
import { envioRawLaunchToEvent, hydrateV1SwapFromDecoded, type EnvioRawLaunchRow, type EnvioRawSwapRow } from './transformV1Legacy.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, hydrateCurveTradeFromDecoded, hydrateCurveBuybackFromDecoded,
  resolveKnownQuoteAsset, type EnvioRawLaunchV2Row, type EnvioRawCurveTradeRow, type EnvioRawCurveBuybackRow } from './transformV2.js';
import { envioRawLifecycleToTransition, type EnvioRawLifecycleRow } from './transformLifecycle.js';
import { verifyV4PoolFromEnvio, openV4Venue, hydrateV4SwapFromDecoded,
  type EnvioRawV4InitializeRow, type EnvioRawV4SwapRow } from './transformV4.js';
import { enqueueFeedResolutionJob } from '../market/quotePricing/priceJobStore.js';

export const DEFAULT_STREAM_TABLES: Record<Stream, string> = {
  'v1-launch': 'envio."RawLaunch"',
  'v1-swap': 'envio."RawSwap"',
  'v2-launch': 'envio."RawLaunchV2"',
  'v2-curve': 'envio."RawCurveTrade"',
  'v2-buyback': 'envio."RawCurveBuyback"',
  'v2-lifecycle': 'envio."RawLifecycleTransition"',
  'v4-initialize': 'envio."RawV4Initialize"',
  'v4-swap': 'envio."RawV4Swap"',
};

// Dependency order within one pass: each downstream stream's apply step reads the app-DB state a
// prior stream in this list just committed (its own transaction), never an in-memory map built from a
// full-table scan — see the spec's "V1 launch -> V1 swap", "V2 launch -> curve/buyback/lifecycle", and
// "V2 lifecycle -> verified V4 venue -> V4 swap" chains. STREAMS is already declared in this order.
export const STREAM_ORDER: readonly Stream[] = STREAMS;

const v1Factories = getPonsFactorySources().filter((factory) => factory.version === 'v1');
const v1FactoryByAddress = new Map(v1Factories.map((factory) => [factory.factory.toLowerCase(), factory]));
function resolveV1Factory(factoryAddress: string): FactorySource {
  const factory = v1FactoryByAddress.get(factoryAddress.toLowerCase());
  if (!factory) throw new Error(`Unknown V1 factory address ${factoryAddress} — not registered in sourceRegistry.ts`);
  return factory;
}
const v2Factory = getPonsFactorySources()[2]!;
const v4PoolManager = '0x8366a39cC670b4001a1121b8f6A443A643E40951';

type ApplyOutcome = 'applied' | 'unresolved' | 'skipped';
interface QuoteAssetToEnqueue { chainId: number; quoteAssetAddress: string }

function toLaunchFromRow(row: typeof launches.$inferSelect): Launch {
  return {
    chainId: row.chainId, tokenAddress: row.tokenAddress as Address, name: row.name, symbol: row.symbol,
    tokenDecimals: row.tokenDecimals, platform: 'pons', protocolVersion: row.protocolVersion as Launch['protocolVersion'],
    sourceId: row.sourceId, sourceLogId: row.sourceLogId ?? '',
    factoryAddress: row.factoryAddress as Address, deployerAddress: row.deployerAddress as Address,
    launchBlock: row.launchBlock, launchTxHash: row.launchTxHash as Hash,
    quoteAsset: { address: row.quoteAssetAddress as Address, symbol: row.quoteAssetSymbol, decimals: row.quoteAssetDecimals },
    lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
    v4PoolFee: row.v4PoolFee, v4TickSpacing: row.v4TickSpacing, logoUri: row.logoUri, description: row.description,
    websiteUrl: row.websiteUrl, twitterUrl: row.twitterUrl, launchTimestamp: row.launchTimestamp,
  };
}
function toVenueFromRow(row: typeof venues.$inferSelect): Venue {
  return {
    id: row.id, chainId: row.chainId, tokenAddress: row.tokenAddress as Address, kind: row.kind as VenueKind,
    ref: row.ref, sourceId: row.sourceId, sourceLogId: row.sourceLogId ?? '',
    effectiveFromBlock: row.effectiveFromBlock, effectiveFromLogIndex: row.effectiveFromLogIndex,
    effectiveToBlock: row.effectiveToBlock, effectiveToLogIndex: row.effectiveToLogIndex, official: row.official,
  };
}
async function lookupLaunch(db: DbOrTx, chainId: number, tokenAddress: string): Promise<Launch | null> {
  const [row] = await db.select().from(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, tokenAddress.toLowerCase())));
  return row ? toLaunchFromRow(row) : null;
}
async function lookupVenue(db: DbOrTx, chainId: number, kind: VenueKind, ref: string): Promise<Venue | null> {
  const [row] = await db.select().from(venues).where(and(eq(venues.chainId, chainId), eq(venues.kind, kind), eq(venues.ref, ref.toLowerCase())));
  return row ? toVenueFromRow(row) : null;
}
function num(value: unknown): bigint { return BigInt(String(value)); }
function str(value: unknown): string { return String(value); }
function int(value: unknown): number { return Number(value); }

// ---- v1-launch ----
// No RPC prefetch: name/symbol/decimals/graduation are deferred to the core-metadata enrichment job
// (be/src/launchpads/pons/coreMetadata.ts) — see docs/superpowers/specs/
// 2026-10-05-envio-near-realtime-sync-design.md's "Immediate launch records and enrichment". V1's
// quote asset is always WETH (zero RPC calls, enforced inside hydrateV1Launch itself).
async function applyV1Launch(tx: DbOrTx, chainId: number, raw: Record<string, unknown>, newQuoteAssets: QuoteAssetToEnqueue[]): Promise<ApplyOutcome> {
  const row: EnvioRawLaunchRow = {
    chainId, tokenAddress: str(raw.tokenAddress), deployerAddress: str(raw.deployerAddress),
    pairTokenAddress: str(raw.pairTokenAddress), poolAddress: str(raw.poolAddress), factoryAddress: str(raw.factoryAddress),
    blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash), txHash: str(raw.txHash), logIndex: int(raw.logIndex),
  };
  const event = envioRawLaunchToEvent(row);
  const tokenAddress = event.tokenAddress.toLowerCase();
  const existing = await lookupLaunch(tx, chainId, tokenAddress);
  if (existing) return 'applied';
  const factory = resolveV1Factory(row.factoryAddress);
  let launch: Launch; let venue: Venue;
  try {
    ({ launch, venue } = hydrateV1Launch(event, factory, null, null));
  } catch (error) {
    throw new Error(`Failed to apply V1 launch at tx ${row.txHash} log ${row.logIndex}: ${(error as Error).message}`, { cause: error });
  }
  await tx.insert(launches).values({
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, sourceId: launch.sourceId, sourceLogId: null,
    launchLogIndex: row.logIndex, name: launch.name, symbol: launch.symbol, tokenDecimals: launch.tokenDecimals,
    platform: launch.platform, protocolVersion: launch.protocolVersion, factoryAddress: launch.factoryAddress,
    deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock, launchBlockHash: row.blockHash,
    launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
    quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
  }).onConflictDoNothing();
  await tx.insert(venues).values({
    id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
    sourceId: `${factory.id}-trades`, sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
  }).onConflictDoNothing();
  newQuoteAssets.push({ chainId: launch.chainId, quoteAssetAddress: launch.quoteAsset.address });
  return 'applied';
}

// ---- v1-swap ----
async function applyV1Swap(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<ApplyOutcome> {
  const poolAddress = str(raw.poolAddress).toLowerCase();
  const venue = await lookupVenue(tx, chainId, 'v3_pool', poolAddress);
  if (!venue) return 'unresolved';
  const launch = await lookupLaunch(tx, chainId, venue.tokenAddress);
  if (!launch) return 'unresolved';
  const row: EnvioRawSwapRow = {
    poolAddress: str(raw.poolAddress), amount0: num(raw.amount0), amount1: num(raw.amount1), sqrtPriceX96: num(raw.sqrtPriceX96),
    blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash), txHash: str(raw.txHash), logIndex: int(raw.logIndex),
    timestamp: int(raw.timestamp),
  };
  let trade;
  try {
    trade = hydrateV1SwapFromDecoded(row, venue, launch, str(raw.txFrom) as Address);
  } catch (error) {
    throw new Error(`Failed to apply V1 swap at tx ${row.txHash} log ${row.logIndex}: ${(error as Error).message}`, { cause: error });
  }
  if (!trade) return 'applied';
  await tx.insert(trades).values({
    chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
    blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
    tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(),
    activityKind: trade.activityKind, quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent,
    sourceLogId: null, priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null,
    priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null, traderAddress: trade.traderAddress,
  }).onConflictDoNothing();
  return 'applied';
}

// ---- v2-launch ----
// No RPC prefetch: name/symbol/decimals are deferred to the core-metadata enrichment job. The quote
// asset's address is always known from the event itself; its symbol/decimals are known for free only
// on the native-ETH fast path (resolveKnownQuoteAsset) — an unknown real ERC20 pair defers those two
// fields to the same enrichment job.
async function applyV2Launch(tx: DbOrTx, chainId: number, raw: Record<string, unknown>, newQuoteAssets: QuoteAssetToEnqueue[]): Promise<ApplyOutcome> {
  const row: EnvioRawLaunchV2Row = {
    chainId, tokenAddress: str(raw.tokenAddress), curveAddress: str(raw.curveAddress), deployerAddress: str(raw.deployerAddress),
    pairTokenAddress: str(raw.pairTokenAddress), blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash),
    txHash: str(raw.txHash), logIndex: int(raw.logIndex),
  };
  const event = envioRawLaunchV2ToEvent(row);
  const tokenAddress = event.tokenAddress.toLowerCase();
  const existing = await lookupLaunch(tx, chainId, tokenAddress);
  if (existing) return 'applied';
  const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
  const quoteAsset = { address: event.pairToken, symbol: knownQuoteAsset?.symbol ?? null, decimals: knownQuoteAsset?.decimals ?? null };
  let launch: Launch; let venue: Venue;
  try {
    ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory, null, quoteAsset));
  } catch (error) {
    throw new Error(`Failed to apply V2 launch at tx ${row.txHash} log ${row.logIndex}: ${(error as Error).message}`, { cause: error });
  }
  await tx.insert(launches).values({
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, sourceId: launch.sourceId, sourceLogId: null,
    launchLogIndex: row.logIndex, name: launch.name, symbol: launch.symbol, tokenDecimals: launch.tokenDecimals,
    platform: launch.platform, protocolVersion: launch.protocolVersion, factoryAddress: launch.factoryAddress,
    deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock, launchBlockHash: row.blockHash,
    launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
    quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
  }).onConflictDoNothing();
  await tx.insert(venues).values({
    id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
    sourceId: 'pons-v2-curve', sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
  }).onConflictDoNothing();
  newQuoteAssets.push({ chainId: launch.chainId, quoteAssetAddress: launch.quoteAsset.address });
  return 'applied';
}

// ---- v2-curve / v2-buyback ----
async function applyV2Curve(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<ApplyOutcome> {
  const curveAddress = str(raw.curveAddress).toLowerCase();
  const venue = await lookupVenue(tx, chainId, 'curve', curveAddress);
  if (!venue) return 'unresolved';
  const launch = await lookupLaunch(tx, chainId, venue.tokenAddress);
  if (!launch) return 'unresolved';
  const row: EnvioRawCurveTradeRow = {
    curveAddress: str(raw.curveAddress), side: str(raw.side) as 'buy' | 'sell', tokenAmountRaw: num(raw.tokenAmountRaw),
    quoteAmountRaw: num(raw.quoteAmountRaw), feeRaw: num(raw.feeRaw), taxRaw: num(raw.taxRaw), txFrom: str(raw.txFrom),
    blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash), txHash: str(raw.txHash), logIndex: int(raw.logIndex),
    timestamp: int(raw.timestamp),
  };
  const trade = hydrateCurveTradeFromDecoded(row, venue, launch);
  await tx.insert(trades).values({
    chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
    blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
    tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
    quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
    priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
  }).onConflictDoNothing();
  return 'applied';
}
async function applyV2Buyback(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<ApplyOutcome> {
  const curveAddress = str(raw.curveAddress).toLowerCase();
  const venue = await lookupVenue(tx, chainId, 'curve', curveAddress);
  if (!venue) return 'unresolved';
  const launch = await lookupLaunch(tx, chainId, venue.tokenAddress);
  if (!launch) return 'unresolved';
  const row: EnvioRawCurveBuybackRow = {
    curveAddress: str(raw.curveAddress), quoteSpentRaw: num(raw.quoteSpentRaw), tokensLockedRaw: num(raw.tokensLockedRaw),
    txFrom: str(raw.txFrom), blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash), txHash: str(raw.txHash),
    logIndex: int(raw.logIndex), timestamp: int(raw.timestamp),
  };
  const trade = hydrateCurveBuybackFromDecoded(row, venue, launch);
  await tx.insert(trades).values({
    chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
    blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
    tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
    quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
    priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
  }).onConflictDoNothing();
  return 'applied';
}

// ---- v2-lifecycle ----
const LIFECYCLE_STATUS_BY_PHASE: Record<1 | 2 | 3, LifecycleStatus> = { 1: 'swept', 2: 'graduated', 3: 'rescued' };
async function applyV2Lifecycle(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<ApplyOutcome> {
  const row: EnvioRawLifecycleRow = {
    chainId, tokenAddress: str(raw.tokenAddress), phase: int(raw.phase) as 1 | 2 | 3, kind: str(raw.kind) as EnvioRawLifecycleRow['kind'],
    blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash), txHash: str(raw.txHash), logIndex: int(raw.logIndex),
  };
  const launch = await lookupLaunch(tx, chainId, row.tokenAddress);
  if (!launch) return 'unresolved';
  const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
  const inserted = await tx.insert(lifecycleTransitions).values({
    sourceLogId: null, chainId: transition.chainId, tokenAddress: transition.tokenAddress, sourceId: 'pons-v2-lifecycle',
    phase: transition.phase, kind: transition.kind, blockNumber: transition.blockNumber, blockHash: transition.blockHash,
    txHash: transition.txHash, logIndex: transition.logIndex,
  }).onConflictDoNothing().returning({ txHash: lifecycleTransitions.txHash });
  if (inserted.length === 0) return 'applied';
  await tx.update(launches).set({ lifecycleStatus: LIFECYCLE_STATUS_BY_PHASE[transition.phase] })
    .where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, transition.tokenAddress)));
  if (transition.phase === 1) {
    await tx.update(venues).set({ effectiveToBlock: transition.blockNumber, effectiveToLogIndex: transition.logIndex })
      .where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, transition.tokenAddress), eq(venues.kind, 'curve')));
  }
  return 'applied';
}

// ---- v4-initialize ----
async function applyV4Initialize(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<ApplyOutcome> {
  const txHash = str(raw.txHash).toLowerCase();
  const [graduation] = await tx.select().from(lifecycleTransitions)
    .where(and(eq(lifecycleTransitions.chainId, chainId), eq(lifecycleTransitions.kind, 'graduated'), eq(lifecycleTransitions.txHash, txHash)));
  if (!graduation) return 'skipped'; // not a Pons graduation pool — most V4 Initialize activity on this chain
  const launch = await lookupLaunch(tx, chainId, graduation.tokenAddress);
  const curveVenue = await lookupVenue(tx, chainId, 'curve', graduation.tokenAddress);
  if (!launch || !curveVenue) return 'unresolved';
  const existingV4 = await lookupVenue(tx, chainId, 'v4_pool', str(raw.poolId));
  if (existingV4) return 'applied';
  const row: EnvioRawV4InitializeRow = {
    poolId: str(raw.poolId), currency0: str(raw.currency0), currency1: str(raw.currency1), fee: int(raw.fee),
    tickSpacing: int(raw.tickSpacing), hooks: str(raw.hooks), blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash),
    txHash: str(raw.txHash), logIndex: int(raw.logIndex),
  };
  const evidence = verifyV4PoolFromEnvio(row, graduation.txHash, graduation.blockHash, launch);
  if (!evidence) return 'skipped'; // same tx, but not the verified Pons pool (e.g. an unrelated Initialize bundled in the same multicall)
  const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: graduation.blockNumber, logIndex: graduation.logIndex });
  await tx.insert(sources).values({
    id: venue.sourceId, chainId: venue.chainId, version: 'v4', factoryAddress: v4PoolManager,
    startBlock: venue.effectiveFromBlock, scannedToBlock: venue.effectiveFromBlock, confirmedToBlock: venue.effectiveFromBlock,
    status: 'backfilling',
  }).onConflictDoNothing();
  await tx.insert(venues).values({
    id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
    sourceId: venue.sourceId, sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
  }).onConflictDoNothing();
  return 'applied';
}

// ---- v4-swap ----
async function applyV4Swap(tx: DbOrTx, chainId: number, raw: Record<string, unknown>): Promise<ApplyOutcome> {
  const poolId = str(raw.poolId).toLowerCase();
  const venue = await lookupVenue(tx, chainId, 'v4_pool', poolId);
  if (!venue) return 'skipped'; // most V4 swap activity on this chain is not a Pons-graduated pool
  const launch = await lookupLaunch(tx, chainId, venue.tokenAddress);
  if (!launch) return 'unresolved';
  const row: EnvioRawV4SwapRow = {
    poolId: str(raw.poolId), sender: str(raw.sender), txFrom: str(raw.txFrom), amount0: num(raw.amount0), amount1: num(raw.amount1),
    sqrtPriceX96: num(raw.sqrtPriceX96), blockNumber: num(raw.blockNumber), blockHash: str(raw.blockHash), txHash: str(raw.txHash),
    logIndex: int(raw.logIndex), timestamp: int(raw.timestamp),
  };
  let trade;
  try {
    trade = hydrateV4SwapFromDecoded(row, venue, launch, launch.quoteAsset.decimals);
  } catch (error) {
    throw new Error(`Failed to apply V4 swap at tx ${row.txHash} log ${row.logIndex}: ${(error as Error).message}`, { cause: error });
  }
  if (!trade) return 'applied';
  await tx.insert(trades).values({
    chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
    blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
    tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
    quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
    priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null, priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
    traderAddress: trade.traderAddress,
  }).onConflictDoNothing();
  return 'applied';
}

export interface ApplyPageInput {
  chainId: number;
  stream: Stream;
  lane: Lane;
  fence: bigint;
  limit: number;
  tables?: Partial<Record<Stream, string>>;
}
export interface ApplyPageResult { applied: number; unresolved: number; cursor: SyncCursor }

const TAIL_SEED_DEPTH = 500n;

/**
 * Reads and applies exactly one bounded page of one Envio raw stream, in one app-DB transaction with
 * its cursor advance. No RPC calls: a new launch's name/symbol/decimals (and V1 graduation, and an
 * unresolved V2 quote asset) are left null for the core-metadata enrichment job — see
 * be/src/launchpads/pons/coreMetadata.ts. A fresh `tail` cursor seeds near `fence - 500` blocks
 * instead of genesis (the `history` lane owns full backfill from the stream's true start). Downstream
 * rows whose launch/venue dependency isn't in the app DB yet are counted `unresolved`, durably queued
 * via unresolvedEvents.ts (retried independently of this stream's moving cursor), and left unapplied.
 */
export async function applyEnvioPage(envioPool: Pool, appDb: Database, input: ApplyPageInput): Promise<ApplyPageResult> {
  const tables = { ...DEFAULT_STREAM_TABLES, ...input.tables };
  const key = { chainId: input.chainId, stream: input.stream, lane: input.lane };
  const cursor = await claimSyncCursor(appDb, key);
  const fresh = cursor.processedWatermark === null;
  const effectiveAfter: CursorPosition = fresh && input.lane === 'tail'
    ? { blockNumber: input.fence > TAIL_SEED_DEPTH ? input.fence - TAIL_SEED_DEPTH : 0n, logIndex: -1, rawId: '' }
    : cursor.position;
  const page = await readRawPage(envioPool, {
    table: tables[input.stream], chainId: input.chainId, after: effectiveAfter, fence: input.fence, limit: input.limit,
  });

  const newQuoteAssets: QuoteAssetToEnqueue[] = [];
  let applied = 0;
  let unresolved = 0;
  await appDb.transaction(async (tx) => {
    for (const raw of page.rows) {
      const outcome = await applyRow(tx, input.chainId, input.stream, raw, newQuoteAssets);
      if (outcome === 'applied') applied += 1;
      else if (outcome === 'unresolved') {
        unresolved += 1;
        await enqueueUnresolvedEvent(tx, {
          chainId: input.chainId, stream: input.stream, rawId: String(raw.id), reason: 'dependency_missing',
        });
      }
    }
    await advanceSyncCursor(tx, key, page.lastPosition ?? effectiveAfter, input.fence);
  });
  for (const asset of newQuoteAssets) {
    await enqueueFeedResolutionJob(appDb.$client, asset.chainId, asset.quoteAssetAddress)
      .catch(() => { /* best-effort; a later launch sharing the same quote asset will enqueue again */ });
  }
  const next = await claimSyncCursor(appDb, key);
  return { applied, unresolved, cursor: next };
}

async function applyRow(
  tx: DbOrTx, chainId: number, stream: Stream, raw: Record<string, unknown>, newQuoteAssets: QuoteAssetToEnqueue[],
): Promise<ApplyOutcome> {
  switch (stream) {
    case 'v1-launch': return applyV1Launch(tx, chainId, raw, newQuoteAssets);
    case 'v1-swap': return applyV1Swap(tx, chainId, raw);
    case 'v2-launch': return applyV2Launch(tx, chainId, raw, newQuoteAssets);
    case 'v2-curve': return applyV2Curve(tx, chainId, raw);
    case 'v2-buyback': return applyV2Buyback(tx, chainId, raw);
    case 'v2-lifecycle': return applyV2Lifecycle(tx, chainId, raw);
    case 'v4-initialize': return applyV4Initialize(tx, chainId, raw);
    case 'v4-swap': return applyV4Swap(tx, chainId, raw);
  }
}

export interface RetryUnresolvedInput {
  chainId: number;
  stream: Stream;
  limit: number;
  tables?: Partial<Record<Stream, string>>;
  now?: Date;
}

/**
 * Re-attempts due unresolved events for one stream, independent of that stream's raw-read cursor
 * (which already moved past them). Each row is re-fetched by its Envio `id` and re-applied in its own
 * transaction, so one row's failure cannot block another's resolution. Returns the number resolved
 * (applied or now irrelevant) — the rest are rescheduled with backoff by settleUnresolvedEvent.
 */
export async function retryUnresolvedEvents(envioPool: Pool, appDb: Database, input: RetryUnresolvedInput): Promise<number> {
  const tables = { ...DEFAULT_STREAM_TABLES, ...input.tables };
  const now = input.now ?? new Date();
  const claims = await claimDueUnresolvedEvents(appDb, input.chainId, input.stream, now, input.limit);
  let resolved = 0;
  for (const claim of claims) {
    const raw = await readRawRowById(envioPool, tables[input.stream], claim.rawId);
    if (!raw) {
      // The raw row itself is gone (an upstream reorg replaced it) — nothing left to retry.
      await appDb.transaction((tx) => settleUnresolvedEvent(tx, claim, true, now, claim.retryCount));
      resolved += 1;
      continue;
    }
    const newQuoteAssets: QuoteAssetToEnqueue[] = [];
    let outcome: ApplyOutcome = 'unresolved';
    await appDb.transaction(async (tx) => {
      outcome = await applyRow(tx, input.chainId, input.stream, raw, newQuoteAssets);
      await settleUnresolvedEvent(tx, claim, outcome !== 'unresolved', now, claim.retryCount);
    });
    for (const asset of newQuoteAssets) {
      await enqueueFeedResolutionJob(appDb.$client, asset.chainId, asset.quoteAssetAddress).catch(() => { /* best-effort */ });
    }
    if (outcome !== 'unresolved') resolved += 1;
  }
  return resolved;
}

export interface SyncReport {
  lane: Lane;
  fence: bigint;
  results: Partial<Record<Stream, { applied: number; unresolved: number }>>;
}
export interface RunPassInput {
  chainId: number;
  envioPool: Pool;
  appDb: Database;
  fence: bigint;
  limit: number;
  tables?: Partial<Record<Stream, string>>;
}

async function runPass(lane: Lane, input: RunPassInput): Promise<SyncReport> {
  const results: SyncReport['results'] = {};
  for (const stream of STREAM_ORDER) {
    const result = await applyEnvioPage(input.envioPool, input.appDb, {
      chainId: input.chainId, stream, lane, fence: input.fence, limit: input.limit, tables: input.tables,
    });
    results[stream] = { applied: result.applied, unresolved: result.unresolved };
  }
  return { lane, fence: input.fence, results };
}

/** One bounded page per stream, starting near the current head (with reorg-window overlap on first run). */
export async function runTailPass(input: RunPassInput): Promise<SyncReport> {
  return runPass('tail', input);
}
/** One bounded page per stream, resuming from each stream's earliest unsynced block. */
export async function runHistoryPass(input: RunPassInput): Promise<SyncReport> {
  return runPass('history', input);
}
