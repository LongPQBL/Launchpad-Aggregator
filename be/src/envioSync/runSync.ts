import type { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import type { Address } from 'viem';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { hydrateV1Launch, type V1TokenMetadata } from '../launchpads/pons/v1/adapter.js';
import { readV1TokenMetadata, readV1Graduation, type V1ReadClient } from '../launchpads/pons/v1/state.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, launches, venues, trades, sources } from '../db/schema.js';
import { envioRawLaunchToEvent, hydrateV1SwapFromDecoded, type EnvioRawLaunchRow, type EnvioRawSwapRow } from './transformV1Legacy.js';
import { readAllRawLaunches, readAllRawSwaps, readEnvioProgress } from './envioDb.js';
import { reconcileReorgWindow } from './reorgGuard.js';

const legacy = getPonsFactorySources()[0];

export interface EnvioTableNames {
  rawLaunchTable: string;
  rawSwapTable: string;
  progressTable?: string;
}

export async function syncV1LegacyToReal(
  envioPool: Pool, appDb: Database, tables: EnvioTableNames = DEFAULT_ENVIO_TABLES,
  rpcClient: V1ReadClient = defaultRpcClient(), reorgWindowBlocks = 500n,
): Promise<{ launchesWritten: number; tradesWritten: number }> {
  const { processedBlock, headBlock } = await readEnvioProgress(envioPool, tables.progressTable);
  const windowStart = processedBlock > reorgWindowBlocks ? processedBlock - reorgWindowBlocks : 0n;

  const existingRows = await appDb.select().from(launches).where(eq(launches.sourceId, legacy.id));
  const existingByToken = new Map(existingRows.map((row) => [row.tokenAddress.toLowerCase(), row]));
  const rawLaunches = await readAllRawLaunches(envioPool, tables.rawLaunchTable);

  // Fetch every RPC metadata call this cycle will need BEFORE deleting anything. A launch is
  // "about to be rebuilt" either because it doesn't exist yet, or because it exists but falls inside
  // the reorg window reconcileReorgWindow is about to clear (sourceLogId null, launchBlock >=
  // windowStart). Doing this first means a single bad RPC call (seen in production: 403/429 on this
  // chain, or a non-standard token) throws BEFORE the delete runs — the window stays fully intact,
  // rather than leaving a visible hole in the live API until the next successful cycle (final review,
  // Critical 2).
  const metadataByToken = new Map<string, V1TokenMetadata>();
  // Graduation status, fetched alongside metadata (same RPC call pattern as the RPC-scan indexer's
  // own loadV1 — be/src/cli/runFactoryIndexer.ts) rather than hardcoded false. A V1 launch that had
  // already graduated before Envio ever saw it would otherwise be permanently misreported as
  // 'trading' — a fabricated value, not a null, which CLAUDE.md's "null means unavailable" rule
  // never permits (final review, Important 5).
  const graduatedByToken = new Map<string, boolean>();
  for (const raw of rawLaunches) {
    const tokenAddress = raw.tokenAddress.toLowerCase();
    const existing = existingByToken.get(tokenAddress);
    const willBeRebuilt = !existing || (existing.sourceLogId === null && existing.launchBlock >= windowStart);
    if (!willBeRebuilt || metadataByToken.has(tokenAddress)) continue;
    const [metadata, graduated] = await Promise.all([
      readV1TokenMetadata(rpcClient, tokenAddress as Address),
      readV1Graduation(rpcClient, tokenAddress as Address, legacy.factory),
    ]);
    metadataByToken.set(tokenAddress, metadata);
    graduatedByToken.set(tokenAddress, graduated);
  }

  const launchByPool = new Map<string, { launch: Launch; venue: Venue }>();
  let launchesWritten = 0;
  let tradesWritten = 0;
  await appDb.transaction(async (tx) => {
    await reconcileReorgWindow(tx, { launches, venues, trades }, windowStart, {
      venueKinds: ['v3_pool'], launchSourceIds: [legacy.id],
    });
    const survivingRows = await tx.select().from(launches).where(eq(launches.sourceId, legacy.id));
    const survivingByToken = new Map(survivingRows.map((row) => [row.tokenAddress.toLowerCase(), row]));

    for (const raw of rawLaunches) {
      const row: EnvioRawLaunchRow = { ...raw, blockNumber: BigInt(raw.blockNumber) };
      const event = envioRawLaunchToEvent(row);
      const tokenAddress = event.tokenAddress.toLowerCase();
      const surviving = survivingByToken.get(tokenAddress);
      const metadata = surviving
        ? { name: surviving.name, symbol: surviving.symbol, decimals: surviving.tokenDecimals, liquidityPool: event.poolAddress }
        : metadataByToken.get(tokenAddress);
      const graduated = surviving ? surviving.lifecycleStatus === 'graduated' : graduatedByToken.get(tokenAddress);
      if (!metadata || graduated === undefined) throw new Error(`Missing pre-fetched metadata for ${tokenAddress} — this is a bug in the pre-fetch scoping above`);
      let launch: Launch;
      let venue: Venue;
      try {
        ({ launch, venue } = hydrateV1Launch(event, legacy, metadata, graduated));
      } catch (error) {
        throw new Error(`Failed to sync launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
      }
      launchByPool.set(event.poolAddress.toLowerCase(), { launch, venue });
      if (!surviving) {
        const inserted = await tx.insert(launches).values({
          chainId: launch.chainId, tokenAddress: launch.tokenAddress, sourceId: launch.sourceId, sourceLogId: null,
          launchLogIndex: raw.logIndex, name: launch.name, symbol: launch.symbol, tokenDecimals: launch.tokenDecimals,
          platform: launch.platform, protocolVersion: launch.protocolVersion, factoryAddress: launch.factoryAddress,
          deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock, launchTxHash: launch.launchTxHash,
          quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
          quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
        }).onConflictDoNothing().returning({ tokenAddress: launches.tokenAddress });
        if (inserted.length) launchesWritten += 1;
      }
      await tx.insert(venues).values({
        id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
        sourceId: `${legacy.id}-trades`, sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
      }).onConflictDoNothing();
    }

    const rawSwaps = await readAllRawSwaps(envioPool, tables.rawSwapTable);
    for (const raw of rawSwaps) {
      const context = launchByPool.get(raw.poolAddress.toLowerCase());
      if (!context) continue;
      const row: EnvioRawSwapRow = { ...raw, amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1),
        sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity), blockNumber: BigInt(raw.blockNumber) };
      let trade;
      try {
        trade = hydrateV1SwapFromDecoded(row, context.venue, context.launch, raw.txFrom as Address);
      } catch (error) {
        throw new Error(`Failed to sync swap at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
      }
      if (!trade) continue;
      const inserted = await tx.insert(trades).values({
        chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
        blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
        tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(),
        activityKind: trade.activityKind, quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent,
        sourceLogId: null, priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null,
        priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null, traderAddress: trade.traderAddress,
      }).onConflictDoNothing().returning({ txHash: trades.txHash });
      if (inserted.length) tradesWritten += 1;
    }

    const status = processedBlock >= headBlock ? 'caught_up' : 'backfilling';
    for (const id of [legacy.id, `${legacy.id}-trades`]) {
      await tx.update(sources).set({ confirmedToBlock: processedBlock, scannedToBlock: processedBlock, status })
        .where(eq(sources.id, id));
    }
  });
  return { launchesWritten, tradesWritten };
}

// Real, confirmed-empirically (Task 1 Step 7 / Task 2 Step 7) production table names — the default
// unless a caller (e.g. a test standing in a throwaway schema for Envio's own Postgres) overrides them.
export const DEFAULT_ENVIO_TABLES: EnvioTableNames = {
  rawLaunchTable: 'envio."RawLaunch"',
  rawSwapTable: 'envio."RawSwap"',
};

function defaultRpcClient(): V1ReadClient {
  return createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
}

export async function syncV1LegacyOnce(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioTableNames = DEFAULT_ENVIO_TABLES,
  rpcClient: V1ReadClient = defaultRpcClient(),
): Promise<{ launchesWritten: number; tradesWritten: number }> {
  const existingRows = await appDb.select().from(launchesEnvioStaging);
  const existingByToken = new Map(existingRows.map((row) => [row.tokenAddress.toLowerCase(), row]));
  const rawLaunches = await readAllRawLaunches(envioPool, tables.rawLaunchTable);
  let launchesWritten = 0;
  const launchByPool = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchRow = {
      chainId: raw.chainId,
      tokenAddress: raw.tokenAddress,
      deployerAddress: raw.deployerAddress,
      pairTokenAddress: raw.pairTokenAddress,
      poolAddress: raw.poolAddress,
      blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash,
      txHash: raw.txHash,
      logIndex: raw.logIndex,
    };
    const event = envioRawLaunchToEvent(row);
    const existing = existingByToken.get(event.tokenAddress.toLowerCase());
    const isNew = !existing;
    const metadata = !existing || existing.name === null || existing.symbol === null
      ? await readV1TokenMetadata(rpcClient, event.tokenAddress)
      : { name: existing.name, symbol: existing.symbol, decimals: existing.tokenDecimals, liquidityPool: event.poolAddress };
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV1Launch(event, legacy, metadata, false));
    } catch (error) {
      throw new Error(`Failed to sync launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByPool.set(event.poolAddress, { launch, venue });
    if (existing && (existing.name === null || existing.symbol === null)) {
      await appDb.update(launchesEnvioStaging).set({ name: metadata.name, symbol: metadata.symbol, tokenDecimals: metadata.decimals })
        .where(eq(launchesEnvioStaging.tokenAddress, event.tokenAddress));
    }
    if (isNew) {
    const inserted = await appDb.transaction(async (tx) => {
      const launchRows = await tx.insert(launchesEnvioStaging).values({
        chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name, symbol: launch.symbol,
        tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
        factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
        launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
        quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: null,
      }).onConflictDoNothing().returning({ tokenAddress: launchesEnvioStaging.tokenAddress });
      if (launchRows.length === 0) return false;
      await tx.insert(venuesEnvioStaging).values({
        id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
        effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
      }).onConflictDoNothing();
      return true;
    });
    if (inserted) launchesWritten += 1;
    }
  }

  const rawSwaps = await readAllRawSwaps(envioPool, tables.rawSwapTable);
  let tradesWritten = 0;
  for (const raw of rawSwaps) {
    const context = launchByPool.get(raw.poolAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawSwapRow = {
      poolAddress: raw.poolAddress, sender: raw.sender, recipient: raw.recipient,
      amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1), sqrtPriceX96: BigInt(raw.sqrtPriceX96),
      liquidity: BigInt(raw.liquidity), tick: raw.tick, blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash, txHash: raw.txHash, logIndex: raw.logIndex, timestamp: raw.timestamp,
    };
    let trade;
    try {
      // traderAddress is the transaction's originating EOA (tx.from), not the Swap event's own
      // `sender` param — see envio/schema.graphql's RawSwap.txFrom doc comment.
      trade = hydrateV1SwapFromDecoded(row, context.venue, context.launch, raw.txFrom as Address);
    } catch (error) {
      throw new Error(`Failed to sync swap at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
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
  return { launchesWritten, tradesWritten };
}
