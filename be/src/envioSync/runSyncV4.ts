import type { Pool } from 'pg';
import { and, eq, like, notExists } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging,
  launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';
import { readEnvioProgress } from './envioDb.js';
import { reconcileReorgWindow } from './reorgGuard.js';
import { verifyV4PoolFromEnvio, openV4Venue, hydrateV4SwapFromDecoded, type EnvioRawV4InitializeRow, type EnvioRawV4SwapRow } from './transformV4.js';

export interface EnvioV4TableNames {
  rawV4InitializeTable: string;
  rawV4SwapTable: string;
  progressTable?: string;
}

export const DEFAULT_ENVIO_V4_TABLES: EnvioV4TableNames = {
  rawV4InitializeTable: 'envio."RawV4Initialize"',
  rawV4SwapTable: 'envio."RawV4Swap"',
};

interface StagedLaunchRow {
  chainId: number; tokenAddress: string; name: string | null; symbol: string | null; tokenDecimals: number;
  factoryAddress: string; deployerAddress: string; launchBlock: bigint; launchTxHash: string;
  quoteAssetAddress: string; quoteAssetSymbol: string | null; quoteAssetDecimals: number | null;
}

// launch.quoteAsset.decimals is faked to 0 here purely as a type placeholder — it is never read for
// price math. hydrateV4SwapFromDecoded takes the real nullable quoteAssetDecimals as its own explicit
// parameter (see transformV4.ts) so a genuinely unknown ERC20 decimals value is never faked into a
// computed price, matching transformV2.ts's resolveKnownQuoteAsset discipline for curve trades.
function toLaunch(row: StagedLaunchRow): Launch {
  return {
    chainId: row.chainId, tokenAddress: row.tokenAddress as `0x${string}`,
    name: row.name ?? '', symbol: row.symbol ?? '', tokenDecimals: row.tokenDecimals,
    platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
    factoryAddress: row.factoryAddress as `0x${string}`, deployerAddress: row.deployerAddress as `0x${string}`,
    launchBlock: row.launchBlock, launchTxHash: row.launchTxHash as `0x${string}`,
    quoteAsset: { address: row.quoteAssetAddress as `0x${string}`, symbol: row.quoteAssetSymbol ?? '', decimals: row.quoteAssetDecimals ?? 0 },
    lifecycleStatus: 'graduated',
  };
}

export async function syncV4Once(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV4TableNames = DEFAULT_ENVIO_V4_TABLES,
): Promise<{ venuesOpened: number; tradesWritten: number }> {
  // Graduated launches that don't yet have a v4_pool venue opened.
  const pendingGraduations = await appDb
    .select({
      tokenAddress: lifecycleTransitionsEnvioStaging.tokenAddress,
      txHash: lifecycleTransitionsEnvioStaging.txHash,
      blockHash: lifecycleTransitionsEnvioStaging.blockHash,
      blockNumber: lifecycleTransitionsEnvioStaging.blockNumber,
      logIndex: lifecycleTransitionsEnvioStaging.logIndex,
    })
    .from(lifecycleTransitionsEnvioStaging)
    .where(and(
      eq(lifecycleTransitionsEnvioStaging.kind, 'graduated'),
      notExists(appDb.select().from(venuesEnvioStaging).where(and(
        eq(venuesEnvioStaging.tokenAddress, lifecycleTransitionsEnvioStaging.tokenAddress),
        eq(venuesEnvioStaging.kind, 'v4_pool'),
      ))),
    ));

  // Both raw tables are filtered in SQL rather than loaded whole: V4 is indexed unfiltered at the
  // Envio layer (Uniswap's PoolManager is a chain-wide singleton with no dynamic non-address filter
  // available — see the plan's Review Focus), so RawV4Initialize/RawV4Swap grow with total chain
  // activity, not Pons activity (measured: ~1,221 Initialize + ~73,980 Swap events per 100,000-block
  // window). Loading the whole table on every run would not scale to a full-history backfill.
  let venuesOpened = 0;
  if (pendingGraduations.length > 0) {
    const graduationTxHashes = [...new Set(pendingGraduations.map((g) => g.txHash.toLowerCase()))];
    const rawInitializes = (await envioPool.query(
      `SELECT * FROM ${tables.rawV4InitializeTable} WHERE LOWER("txHash") = ANY($1) ORDER BY "blockNumber", "logIndex"`,
      [graduationTxHashes],
    )).rows as EnvioRawV4InitializeRow[];

    for (const graduation of pendingGraduations) {
      const launchRow = (await appDb.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, graduation.tokenAddress)))[0];
      const curveVenueRow = (await appDb.select().from(venuesEnvioStaging).where(and(
        eq(venuesEnvioStaging.tokenAddress, graduation.tokenAddress), eq(venuesEnvioStaging.kind, 'curve'),
      )))[0];
      if (!launchRow || !curveVenueRow) continue;
      const launch = toLaunch(launchRow);
      const curveVenue: Venue = {
        id: curveVenueRow.id, chainId: curveVenueRow.chainId, tokenAddress: curveVenueRow.tokenAddress as `0x${string}`,
        kind: 'curve', ref: curveVenueRow.ref, sourceId: 'pons-v2', sourceLogId: '',
        effectiveFromBlock: curveVenueRow.effectiveFromBlock, effectiveToBlock: null, official: curveVenueRow.official,
      };
      // Matches the RPC-scan path's own candidate selection (indexer/lifecycleRuntime.ts): picks the
      // first same-tx candidate that actually VERIFIES, not just the first same-tx candidate. A
      // graduation transaction could in principle carry more than one Initialize (e.g. an unrelated
      // pool creation bundled into the same multicall) — stopping at the first candidate regardless
      // of whether it verifies could silently drop the real Pons pool if it isn't ordered first.
      let evidence = null;
      for (const candidate of rawInitializes) {
        if (candidate.txHash.toLowerCase() !== graduation.txHash.toLowerCase()) continue;
        const row: EnvioRawV4InitializeRow = { ...candidate, blockNumber: BigInt(candidate.blockNumber) };
        evidence = verifyV4PoolFromEnvio(row, graduation.txHash, graduation.blockHash, launch);
        if (evidence) break;
      }
      if (!evidence) continue;
      const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: graduation.blockNumber, logIndex: graduation.logIndex });
      const venueRows = await appDb.insert(venuesEnvioStaging).values({
        id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
        effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
      }).onConflictDoNothing().returning({ id: venuesEnvioStaging.id });
      if (venueRows.length > 0) venuesOpened += 1;
    }
  }

  // Deliberately re-fetches launch/venue from staging here rather than reusing the objects built in
  // the venue-opening loop above — a v4_pool venue opened in an EARLIER run (not this pass) still
  // needs its swaps synced, so this loop must work uniformly for both "just opened" and
  // "already open" venues, not special-case the former via an in-memory map.
  let tradesWritten = 0;
  const v4Venues = await appDb.select().from(venuesEnvioStaging).where(eq(venuesEnvioStaging.kind, 'v4_pool'));
  if (v4Venues.length > 0) {
    const poolIds = [...new Set(v4Venues.map((v) => v.ref.toLowerCase()))];
    const rawSwaps = (await envioPool.query(
      `SELECT * FROM ${tables.rawV4SwapTable} WHERE LOWER("poolId") = ANY($1) ORDER BY "blockNumber", "logIndex"`,
      [poolIds],
    )).rows as EnvioRawV4SwapRow[];
    const venueByPoolId = new Map(v4Venues.map((v) => [v.ref.toLowerCase(), v]));
    // Cached per token address within this run — the venue-opening loop above re-fetches per
    // graduation since that loop is bounded by pending graduations, but this loop can iterate tens of
    // thousands of swap rows against a handful of distinct pools, so repeating one query per swap
    // would dominate runtime.
    const launchCache = new Map<string, { launch: Launch; quoteAssetDecimals: number | null }>();
    for (const raw of rawSwaps) {
      const venueRow = venueByPoolId.get(raw.poolId.toLowerCase());
      if (!venueRow) continue;
      const tokenKey = venueRow.tokenAddress.toLowerCase();
      let cached = launchCache.get(tokenKey);
      if (!cached) {
        const launchRow = (await appDb.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, venueRow.tokenAddress)))[0];
        if (!launchRow) continue;
        cached = { launch: toLaunch(launchRow), quoteAssetDecimals: launchRow.quoteAssetDecimals };
        launchCache.set(tokenKey, cached);
      }
      const venue: Venue = {
        id: venueRow.id, chainId: venueRow.chainId, tokenAddress: venueRow.tokenAddress as `0x${string}`,
        kind: 'v4_pool', ref: venueRow.ref, sourceId: 'pons-v2-v4', sourceLogId: '',
        effectiveFromBlock: venueRow.effectiveFromBlock, effectiveToBlock: null, official: venueRow.official,
      };
      const row: EnvioRawV4SwapRow = { ...raw, amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1),
        sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity), blockNumber: BigInt(raw.blockNumber) };
      const trade = hydrateV4SwapFromDecoded(row, venue, cached.launch, cached.quoteAssetDecimals);
      if (!trade) continue;
      const tradeRows = await appDb.insert(tradesEnvioStaging).values({
        chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
        blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
        tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
        priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null, priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
        traderAddress: trade.traderAddress,
      }).onConflictDoNothing().returning({ txHash: tradesEnvioStaging.txHash });
      if (tradeRows.length > 0) tradesWritten += 1;
    }
  }

  return { venuesOpened, tradesWritten };
}

const v4PoolManager = '0x8366a39cC670b4001a1121b8f6A443A643E40951';

function toRealLaunch(row: typeof launches.$inferSelect): Launch {
  return {
    chainId: row.chainId, tokenAddress: row.tokenAddress as `0x${string}`, name: row.name, symbol: row.symbol,
    tokenDecimals: row.tokenDecimals, platform: 'pons', protocolVersion: 'v2', sourceId: row.sourceId, sourceLogId: '',
    factoryAddress: row.factoryAddress as `0x${string}`, deployerAddress: row.deployerAddress as `0x${string}`,
    launchBlock: row.launchBlock, launchTxHash: row.launchTxHash as `0x${string}`,
    quoteAsset: { address: row.quoteAssetAddress as `0x${string}`, symbol: row.quoteAssetSymbol, decimals: row.quoteAssetDecimals },
    lifecycleStatus: 'graduated',
  };
}

export async function syncV4ToReal(
  envioPool: Pool, appDb: Database, tables: EnvioV4TableNames = DEFAULT_ENVIO_V4_TABLES, reorgWindowBlocks = 500n,
): Promise<{ venuesOpened: number; tradesWritten: number }> {
  const { processedBlock, headBlock } = await readEnvioProgress(envioPool, tables.progressTable);
  const windowStart = processedBlock > reorgWindowBlocks ? processedBlock - reorgWindowBlocks : 0n;
  await reconcileReorgWindow(appDb, { launches, venues, trades }, windowStart, {
    venueKinds: ['v4_pool'], venueSourceIdPattern: 'pons-v2-v4:%',
  });

  const pendingGraduations = await appDb.select({ tokenAddress: lifecycleTransitions.tokenAddress,
    txHash: lifecycleTransitions.txHash, blockHash: lifecycleTransitions.blockHash,
    blockNumber: lifecycleTransitions.blockNumber, logIndex: lifecycleTransitions.logIndex })
    .from(lifecycleTransitions).where(and(eq(lifecycleTransitions.kind, 'graduated'),
      notExists(appDb.select().from(venues).where(and(eq(venues.tokenAddress, lifecycleTransitions.tokenAddress),
        eq(venues.kind, 'v4_pool'))))));
  let venuesOpened = 0;
  if (pendingGraduations.length) {
    const txHashes = [...new Set(pendingGraduations.map((row) => row.txHash.toLowerCase()))];
    const rawInitializes = (await envioPool.query(`SELECT * FROM ${tables.rawV4InitializeTable}
      WHERE LOWER("txHash") = ANY($1) ORDER BY "blockNumber", "logIndex"`, [txHashes])).rows as EnvioRawV4InitializeRow[];
    for (const graduation of pendingGraduations) {
      const launchRow = (await appDb.select().from(launches).where(eq(launches.tokenAddress, graduation.tokenAddress)))[0];
      const curveRow = (await appDb.select().from(venues).where(and(eq(venues.tokenAddress, graduation.tokenAddress),
        eq(venues.kind, 'curve'))))[0];
      if (!launchRow || !curveRow) continue;
      const launch = toRealLaunch(launchRow);
      const curveVenue: Venue = { id: curveRow.id, chainId: curveRow.chainId,
        tokenAddress: curveRow.tokenAddress as `0x${string}`, kind: 'curve', ref: curveRow.ref,
        sourceId: curveRow.sourceId, sourceLogId: '', effectiveFromBlock: curveRow.effectiveFromBlock,
        effectiveToBlock: curveRow.effectiveToBlock, official: curveRow.official };
      let evidence = null;
      for (const candidate of rawInitializes) {
        if (candidate.txHash.toLowerCase() !== graduation.txHash.toLowerCase()) continue;
        evidence = verifyV4PoolFromEnvio({ ...candidate, blockNumber: BigInt(candidate.blockNumber) },
          graduation.txHash, graduation.blockHash, launch);
        if (evidence) break;
      }
      if (!evidence) continue;
      const venue = openV4Venue(launch, curveVenue, evidence,
        { blockNumber: graduation.blockNumber, logIndex: graduation.logIndex });
      await appDb.insert(sources).values({ id: venue.sourceId, chainId: venue.chainId,
        version: 'v4', factoryAddress: v4PoolManager, startBlock: venue.effectiveFromBlock,
        scannedToBlock: venue.effectiveFromBlock, confirmedToBlock: venue.effectiveFromBlock,
        status: 'backfilling' }).onConflictDoNothing();
      const inserted = await appDb.insert(venues).values({ id: venue.id, chainId: venue.chainId,
        tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref, sourceId: venue.sourceId,
        sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
      }).onConflictDoNothing().returning({ id: venues.id });
      if (inserted.length) venuesOpened += 1;
    }
  }

  let tradesWritten = 0;
  const v4Venues = await appDb.select().from(venues).where(eq(venues.kind, 'v4_pool'));
  if (v4Venues.length) {
    const poolIds = [...new Set(v4Venues.map((row) => row.ref.toLowerCase()))];
    const rawSwaps = (await envioPool.query(`SELECT * FROM ${tables.rawV4SwapTable}
      WHERE LOWER("poolId") = ANY($1) ORDER BY "blockNumber", "logIndex"`, [poolIds])).rows as EnvioRawV4SwapRow[];
    const venueByPool = new Map(v4Venues.map((row) => [row.ref.toLowerCase(), row]));
    const launchCache = new Map<string, Launch>();
    for (const raw of rawSwaps) {
      const venueRow = venueByPool.get(raw.poolId.toLowerCase());
      if (!venueRow) continue;
      let launch = launchCache.get(venueRow.tokenAddress.toLowerCase());
      if (!launch) {
        const launchRow = (await appDb.select().from(launches).where(eq(launches.tokenAddress, venueRow.tokenAddress)))[0];
        if (!launchRow) continue;
        launch = toRealLaunch(launchRow);
        launchCache.set(venueRow.tokenAddress.toLowerCase(), launch);
      }
      const venue: Venue = { id: venueRow.id, chainId: venueRow.chainId,
        tokenAddress: venueRow.tokenAddress as `0x${string}`, kind: 'v4_pool', ref: venueRow.ref,
        sourceId: venueRow.sourceId, sourceLogId: '', effectiveFromBlock: venueRow.effectiveFromBlock,
        effectiveToBlock: venueRow.effectiveToBlock, official: venueRow.official };
      const row: EnvioRawV4SwapRow = { ...raw, amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1),
        sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity), blockNumber: BigInt(raw.blockNumber) };
      const trade = hydrateV4SwapFromDecoded(row, venue, launch, launch.quoteAsset.decimals);
      if (!trade) continue;
      const inserted = await appDb.insert(trades).values({ chainId: trade.chainId, tokenAddress: trade.tokenAddress,
        venueId: trade.venueId, blockNumber: trade.blockNumber, blockHash: trade.blockHash, txHash: trade.txHash,
        logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side, tokenAmountRaw: trade.tokenAmountRaw.toString(),
        quoteAmountRaw: trade.quoteAmountRaw.toString(), quoteAssetAddress: trade.quoteAssetAddress,
        sourceEvent: trade.sourceEvent, activityKind: trade.activityKind, sourceLogId: null,
        priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null,
        priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null, traderAddress: trade.traderAddress,
      }).onConflictDoNothing().returning({ txHash: trades.txHash });
      if (inserted.length) tradesWritten += 1;
    }
  }

  const status = processedBlock >= headBlock ? 'caught_up' : 'backfilling';
  await appDb.update(sources).set({ confirmedToBlock: processedBlock, scannedToBlock: processedBlock, status })
    .where(like(sources.id, 'pons-v2-v4:%'));
  return { venuesOpened, tradesWritten };
}
