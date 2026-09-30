import type { Pool } from 'pg';
import { and, eq, notExists } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { verifyV4PoolFromEnvio, openV4Venue, hydrateV4SwapFromDecoded, type EnvioRawV4InitializeRow, type EnvioRawV4SwapRow } from './transformV4.js';

export interface EnvioV4TableNames {
  rawV4InitializeTable: string;
  rawV4SwapTable: string;
}

export const DEFAULT_ENVIO_V4_TABLES: EnvioV4TableNames = {
  rawV4InitializeTable: 'envio."RawV4Initialize"',
  rawV4SwapTable: 'envio."RawV4Swap"',
};

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

  const rawInitializes = (await envioPool.query(`SELECT * FROM ${tables.rawV4InitializeTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawV4InitializeRow[];
  let venuesOpened = 0;
  for (const graduation of pendingGraduations) {
    const launchRow = (await appDb.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, graduation.tokenAddress)))[0];
    const curveVenueRow = (await appDb.select().from(venuesEnvioStaging).where(and(
      eq(venuesEnvioStaging.tokenAddress, graduation.tokenAddress), eq(venuesEnvioStaging.kind, 'curve'),
    )))[0];
    if (!launchRow || !curveVenueRow) continue;
    const launch: Launch = {
      chainId: launchRow.chainId, tokenAddress: launchRow.tokenAddress as `0x${string}`,
      name: launchRow.name ?? '', symbol: launchRow.symbol ?? '', tokenDecimals: launchRow.tokenDecimals,
      platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
      factoryAddress: launchRow.factoryAddress as `0x${string}`, deployerAddress: launchRow.deployerAddress as `0x${string}`,
      launchBlock: launchRow.launchBlock, launchTxHash: launchRow.launchTxHash as `0x${string}`,
      quoteAsset: { address: launchRow.quoteAssetAddress as `0x${string}`, symbol: launchRow.quoteAssetSymbol ?? '', decimals: launchRow.quoteAssetDecimals ?? 18 },
      lifecycleStatus: 'graduated',
    };
    const curveVenue: Venue = {
      id: curveVenueRow.id, chainId: curveVenueRow.chainId, tokenAddress: curveVenueRow.tokenAddress as `0x${string}`,
      kind: 'curve', ref: curveVenueRow.ref, sourceId: 'pons-v2', sourceLogId: '',
      effectiveFromBlock: curveVenueRow.effectiveFromBlock, effectiveToBlock: null, official: curveVenueRow.official,
    };
    const candidate = rawInitializes.find((row) => row.txHash.toLowerCase() === graduation.txHash.toLowerCase());
    if (!candidate) continue;
    const row: EnvioRawV4InitializeRow = { ...candidate, blockNumber: BigInt(candidate.blockNumber) };
    const evidence = verifyV4PoolFromEnvio(row, graduation.txHash, graduation.blockHash, launch);
    if (!evidence) continue;
    const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: graduation.blockNumber, logIndex: graduation.logIndex });
    const venueRows = await appDb.insert(venuesEnvioStaging).values({
      id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
      effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
    }).onConflictDoNothing().returning({ id: venuesEnvioStaging.id });
    if (venueRows.length > 0) venuesOpened += 1;
  }

  // Deliberately re-fetches launch/venue from staging here rather than reusing the objects built in
  // the venue-opening loop above — a v4_pool venue opened in an EARLIER run (not this pass) still
  // needs its swaps synced, so this loop must work uniformly for both "just opened" and
  // "already open" venues, not special-case the former via an in-memory map.
  let tradesWritten = 0;
  const rawSwaps = (await envioPool.query(`SELECT * FROM ${tables.rawV4SwapTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawV4SwapRow[];
  const v4Venues = await appDb.select().from(venuesEnvioStaging).where(eq(venuesEnvioStaging.kind, 'v4_pool'));
  const venueByPoolId = new Map(v4Venues.map((v) => [v.ref.toLowerCase(), v]));
  for (const raw of rawSwaps) {
    const venueRow = venueByPoolId.get(raw.poolId.toLowerCase());
    if (!venueRow) continue;
    const launchRow = (await appDb.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, venueRow.tokenAddress)))[0];
    if (!launchRow) continue;
    const launch: Launch = {
      chainId: launchRow.chainId, tokenAddress: launchRow.tokenAddress as `0x${string}`,
      name: launchRow.name ?? '', symbol: launchRow.symbol ?? '', tokenDecimals: launchRow.tokenDecimals,
      platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
      factoryAddress: launchRow.factoryAddress as `0x${string}`, deployerAddress: launchRow.deployerAddress as `0x${string}`,
      launchBlock: launchRow.launchBlock, launchTxHash: launchRow.launchTxHash as `0x${string}`,
      quoteAsset: { address: launchRow.quoteAssetAddress as `0x${string}`, symbol: launchRow.quoteAssetSymbol ?? '', decimals: launchRow.quoteAssetDecimals ?? 18 },
      lifecycleStatus: 'graduated',
    };
    const venue: Venue = {
      id: venueRow.id, chainId: venueRow.chainId, tokenAddress: venueRow.tokenAddress as `0x${string}`,
      kind: 'v4_pool', ref: venueRow.ref, sourceId: 'pons-v2-v4', sourceLogId: '',
      effectiveFromBlock: venueRow.effectiveFromBlock, effectiveToBlock: null, official: venueRow.official,
    };
    const row: EnvioRawV4SwapRow = { ...raw, amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1),
      sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity), blockNumber: BigInt(raw.blockNumber) };
    const trade = hydrateV4SwapFromDecoded(row, venue, launch);
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

  return { venuesOpened, tradesWritten };
}
