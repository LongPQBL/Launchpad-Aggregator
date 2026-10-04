import type { Pool } from 'pg';
import type { Address } from 'viem';
import { eq, sql } from 'drizzle-orm';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { readV2TokenMetadata, resolveV2QuoteAsset, type V2QuoteClient } from '../launchpads/pons/v2/adapter.js';
import { mapMetadataReadResults, readExtendedTokenMetadataOutcomes, readLaunchTimestamp,
  type ReadOutcome } from '../launchpads/pons/extendedMetadata.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging,
  launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';
import { readEnvioProgress } from './envioDb.js';
import { reconcileReorgWindow } from './reorgGuard.js';
import { enqueueFeedResolutionJob } from '../market/quotePricing/priceJobStore.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, hydrateCurveTradeFromDecoded, hydrateCurveBuybackFromDecoded, resolveKnownQuoteAsset,
  type EnvioRawLaunchV2Row, type EnvioRawCurveTradeRow, type EnvioRawCurveBuybackRow } from './transformV2.js';
import { envioRawLifecycleToTransition, type EnvioRawLifecycleRow } from './transformLifecycle.js';

const v2Factory = getPonsFactorySources()[2];

export interface EnvioV2TableNames {
  rawLaunchV2Table: string;
  rawCurveTradeTable: string;
  rawCurveBuybackTable: string;
  rawLifecycleTable: string;
  progressTable?: string;
}

export const DEFAULT_ENVIO_V2_TABLES: EnvioV2TableNames = {
  rawLaunchV2Table: 'envio."RawLaunchV2"',
  rawCurveTradeTable: 'envio."RawCurveTrade"',
  rawCurveBuybackTable: 'envio."RawCurveBuyback"',
  rawLifecycleTable: 'envio."RawLifecycleTransition"',
};

function defaultRpcClient(): V2QuoteClient {
  return createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
}

export async function syncV2Once(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV2TableNames = DEFAULT_ENVIO_V2_TABLES,
  rpcClient: V2QuoteClient = defaultRpcClient(),
): Promise<{ launchesWritten: number; tradesWritten: number; transitionsWritten: number }> {
  const rawLaunches = (await envioPool.query(`SELECT * FROM ${tables.rawLaunchV2Table} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLaunchV2Row[];
  const existingRows = await appDb.select().from(launchesEnvioStaging);
  const existingByToken = new Map(existingRows.map((row) => [row.tokenAddress.toLowerCase(), row]));
  let launchesWritten = 0;
  const launchByCurve = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const event = envioRawLaunchV2ToEvent(row);
    const existing = existingByToken.get(event.tokenAddress.toLowerCase());
    const isNew = !existing;
    const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
    const needsMetadata = !existing || existing.name === null || existing.symbol === null;
    const needsQuote = !existing || existing.quoteAssetSymbol === null || existing.quoteAssetDecimals === null;
    const metadata = needsMetadata
      ? await readV2TokenMetadata(rpcClient, event.tokenAddress)
      : { name: existing.name!, symbol: existing.symbol!, decimals: existing.tokenDecimals };
    const quoteAsset = knownQuoteAsset
      ? { address: event.pairToken, ...knownQuoteAsset }
      : needsQuote
        ? await resolveV2QuoteAsset(event.pairToken, rpcClient)
        : { address: event.pairToken, symbol: existing.quoteAssetSymbol!, decimals: existing.quoteAssetDecimals! };
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory, metadata, quoteAsset));
    } catch (error) {
      throw new Error(`Failed to sync V2 launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByCurve.set(event.curveAddress, { launch, venue });
    if (existing && (needsMetadata || needsQuote)) {
      await appDb.update(launchesEnvioStaging).set({ name: metadata.name, symbol: metadata.symbol,
        tokenDecimals: metadata.decimals, quoteAssetSymbol: quoteAsset.symbol, quoteAssetDecimals: quoteAsset.decimals })
        .where(eq(launchesEnvioStaging.tokenAddress, event.tokenAddress));
    }
    if (isNew) {
    const inserted = await appDb.transaction(async (tx) => {
      const launchRows = await tx.insert(launchesEnvioStaging).values({
        chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name, symbol: launch.symbol,
        tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
        factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
        launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address,
        quoteAssetSymbol: launch.quoteAsset.symbol, quoteAssetDecimals: launch.quoteAsset.decimals,
        lifecycleStatus: null,
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

  let tradesWritten = 0;
  const rawTrades = (await envioPool.query(`SELECT * FROM ${tables.rawCurveTradeTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveTradeRow[];
  for (const raw of rawTrades) {
    const context = launchByCurve.get(raw.curveAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawCurveTradeRow = { ...raw, tokenAmountRaw: BigInt(raw.tokenAmountRaw), quoteAmountRaw: BigInt(raw.quoteAmountRaw),
      feeRaw: BigInt(raw.feeRaw), taxRaw: BigInt(raw.taxRaw), blockNumber: BigInt(raw.blockNumber) };
    const trade = hydrateCurveTradeFromDecoded(row, context.venue, context.launch);
    const tradeRows = await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: tradesEnvioStaging.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  const rawBuybacks = (await envioPool.query(`SELECT * FROM ${tables.rawCurveBuybackTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveBuybackRow[];
  for (const raw of rawBuybacks) {
    const context = launchByCurve.get(raw.curveAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawCurveBuybackRow = { ...raw, quoteSpentRaw: BigInt(raw.quoteSpentRaw), tokensLockedRaw: BigInt(raw.tokensLockedRaw), blockNumber: BigInt(raw.blockNumber) };
    const trade = hydrateCurveBuybackFromDecoded(row, context.venue, context.launch);
    const tradeRows = await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: tradesEnvioStaging.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  let transitionsWritten = 0;
  const rawTransitions = (await envioPool.query(`SELECT * FROM ${tables.rawLifecycleTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLifecycleRow[];
  for (const raw of rawTransitions) {
    const row: EnvioRawLifecycleRow = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    const rows = await appDb.insert(lifecycleTransitionsEnvioStaging).values({
      sourceLogId: transition.sourceLogId, chainId: transition.chainId, tokenAddress: transition.tokenAddress,
      phase: transition.phase, kind: transition.kind, blockNumber: transition.blockNumber,
      blockHash: transition.blockHash, txHash: transition.txHash, logIndex: transition.logIndex,
    }).onConflictDoNothing().returning({ sourceLogId: lifecycleTransitionsEnvioStaging.sourceLogId });
    if (rows.length > 0) transitionsWritten += 1;
  }

  return { launchesWritten, tradesWritten, transitionsWritten };
}

type SyncV2RpcClient = V2QuoteClient & { getBlock?(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }> };

export async function syncV2ToReal(
  envioPool: Pool, appDb: Database, tables: EnvioV2TableNames = DEFAULT_ENVIO_V2_TABLES,
  rpcClient: SyncV2RpcClient = defaultRpcClient(), reorgWindowBlocks = 500n,
): Promise<{ launchesWritten: number; tradesWritten: number; transitionsWritten: number }> {
  const { processedBlock, headBlock } = await readEnvioProgress(envioPool, tables.progressTable);
  const windowStart = processedBlock > reorgWindowBlocks ? processedBlock - reorgWindowBlocks : 0n;

  const existingRows = await appDb.select().from(launches).where(eq(launches.sourceId, v2Factory.id));
  const existingByToken = new Map(existingRows.map((row) => [row.tokenAddress.toLowerCase(), row]));
  const rawLaunches = (await envioPool.query(`SELECT * FROM ${tables.rawLaunchV2Table} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLaunchV2Row[];

  // Pre-fetch every RPC call this cycle needs BEFORE reconcileReorgWindow deletes anything — see
  // runSync.ts's syncV1LegacyToReal for the full rationale (final review, Critical 2). A launch is
  // about to be rebuilt if it's new, or if it's inside the reorg window (sourceLogId null,
  // launchBlock >= windowStart).
  const metadataByToken = new Map<string, { name: string; symbol: string; decimals: number }>();
  const quoteAssetByToken = new Map<string, { address: Address; symbol: string; decimals: number }>();
  const extendedByToken = new Map<string, ReturnType<typeof mapMetadataReadResults>>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const event = envioRawLaunchV2ToEvent(row);
    const tokenAddress = event.tokenAddress.toLowerCase();
    const existing = existingByToken.get(tokenAddress);
    const willBeRebuilt = !existing || (existing.sourceLogId === null && existing.launchBlock >= windowStart);
    if (!willBeRebuilt || metadataByToken.has(tokenAddress)) continue;
    const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
    // Independent RPC reads — none needs another's result — started together and awaited as one
    // group, matching syncV1LegacyToReal's metadata+graduated+extended grouping. The known-native-ETH
    // fast path still makes zero RPC calls for the quote asset.
    const [metadata, quoteAsset, extended] = await Promise.all([
      readV2TokenMetadata(rpcClient, event.tokenAddress),
      knownQuoteAsset ? Promise.resolve({ address: event.pairToken, ...knownQuoteAsset }) : resolveV2QuoteAsset(event.pairToken, rpcClient),
      readExtendedTokenMetadataOutcomes(rpcClient, event.tokenAddress),
    ]);
    metadataByToken.set(tokenAddress, metadata);
    quoteAssetByToken.set(tokenAddress, quoteAsset);
    const timestamp: ReadOutcome<number> = rpcClient.getBlock
      ? await readLaunchTimestamp({ getBlock: rpcClient.getBlock.bind(rpcClient) }, row.blockNumber)
      : { state: 'pending', value: null, errorKind: 'unknown' };
    extendedByToken.set(tokenAddress, mapMetadataReadResults({ ...extended, timestamp }));
  }

  const launchByCurve = new Map<string, { launch: Launch; venue: Venue }>();
  let launchesWritten = 0;
  let tradesWritten = 0;
  let transitionsWritten = 0;
  // See runSync.ts's syncV1LegacyToReal for why this is collected here and enqueued after the
  // transaction commits, not inside it.
  const newQuoteAssets: { chainId: number; quoteAssetAddress: string }[] = [];
  await appDb.transaction(async (tx) => {
    await reconcileReorgWindow(tx, { launches, venues, trades, lifecycleTransitions }, windowStart, {
      venueKinds: ['curve'], launchSourceIds: [v2Factory.id],
      transitionSourceIds: ['pons-v2-lifecycle'],
    });
    const survivingRows = await tx.select().from(launches).where(eq(launches.sourceId, v2Factory.id));
    const survivingByToken = new Map(survivingRows.map((row) => [row.tokenAddress.toLowerCase(), row]));

    for (const raw of rawLaunches) {
      const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
      const event = envioRawLaunchV2ToEvent(row);
      const tokenAddress = event.tokenAddress.toLowerCase();
      const surviving = survivingByToken.get(tokenAddress);
      const metadata = surviving
        ? { name: surviving.name, symbol: surviving.symbol, decimals: surviving.tokenDecimals }
        : metadataByToken.get(tokenAddress);
      const quoteAsset = surviving
        ? { address: event.pairToken, symbol: surviving.quoteAssetSymbol, decimals: surviving.quoteAssetDecimals }
        : quoteAssetByToken.get(tokenAddress);
      if (!metadata || !quoteAsset) throw new Error(`Missing pre-fetched metadata/quoteAsset for ${tokenAddress} — this is a bug in the pre-fetch scoping above`);
      let launch: Launch;
      let venue: Venue;
      try {
        ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory, metadata, quoteAsset, extendedByToken.get(tokenAddress)));
      } catch (error) {
        throw new Error(`Failed to sync V2 launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
      }
      launchByCurve.set(event.curveAddress.toLowerCase(), { launch, venue });
      if (!surviving) {
        const inserted = await tx.insert(launches).values({
          chainId: launch.chainId, tokenAddress: launch.tokenAddress, sourceId: launch.sourceId, sourceLogId: null,
          launchLogIndex: raw.logIndex, name: launch.name, symbol: launch.symbol, tokenDecimals: launch.tokenDecimals,
          platform: launch.platform, protocolVersion: launch.protocolVersion, factoryAddress: launch.factoryAddress,
          deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock, launchBlockHash: raw.blockHash,
          launchTxHash: launch.launchTxHash,
          quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
          quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
          logoUri: launch.logoUri ?? null, description: launch.description ?? null,
          websiteUrl: launch.websiteUrl ?? null, twitterUrl: launch.twitterUrl ?? null,
          launchTimestamp: launch.launchTimestamp ?? null,
          logoReadState: extendedByToken.get(tokenAddress)?.logoReadState ?? 'pending',
          descriptionReadState: extendedByToken.get(tokenAddress)?.descriptionReadState ?? 'pending',
          socialsReadState: extendedByToken.get(tokenAddress)?.socialsReadState ?? 'pending',
          timestampReadState: extendedByToken.get(tokenAddress)?.timestampReadState ?? 'pending',
        }).onConflictDoNothing().returning({ tokenAddress: launches.tokenAddress });
        if (inserted.length) {
          launchesWritten += 1;
          newQuoteAssets.push({ chainId: launch.chainId, quoteAssetAddress: launch.quoteAsset.address });
        }
      }
      await tx.insert(venues).values({ id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress,
        kind: venue.kind, ref: venue.ref, sourceId: 'pons-v2-curve', sourceLogId: null,
        effectiveFromBlock: venue.effectiveFromBlock, official: venue.official }).onConflictDoNothing();
    }

    const rawTrades = (await envioPool.query(`SELECT * FROM ${tables.rawCurveTradeTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveTradeRow[];
    for (const raw of rawTrades) {
      const context = launchByCurve.get(raw.curveAddress.toLowerCase());
      if (!context) continue;
      const row: EnvioRawCurveTradeRow = { ...raw, tokenAmountRaw: BigInt(raw.tokenAmountRaw), quoteAmountRaw: BigInt(raw.quoteAmountRaw),
        feeRaw: BigInt(raw.feeRaw), taxRaw: BigInt(raw.taxRaw), blockNumber: BigInt(raw.blockNumber) };
      const trade = hydrateCurveTradeFromDecoded(row, context.venue, context.launch);
      const inserted = await tx.insert(trades).values({ chainId: trade.chainId, tokenAddress: trade.tokenAddress,
        venueId: trade.venueId, blockNumber: trade.blockNumber, blockHash: trade.blockHash, txHash: trade.txHash,
        logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side, tokenAmountRaw: trade.tokenAmountRaw.toString(),
        quoteAmountRaw: trade.quoteAmountRaw.toString(), quoteAssetAddress: trade.quoteAssetAddress,
        sourceEvent: trade.sourceEvent, activityKind: trade.activityKind, sourceLogId: null,
        priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
      }).onConflictDoNothing().returning({ txHash: trades.txHash });
      if (inserted.length) tradesWritten += 1;
    }
    const rawBuybacks = (await envioPool.query(`SELECT * FROM ${tables.rawCurveBuybackTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveBuybackRow[];
    for (const raw of rawBuybacks) {
      const context = launchByCurve.get(raw.curveAddress.toLowerCase());
      if (!context) continue;
      const row: EnvioRawCurveBuybackRow = { ...raw, quoteSpentRaw: BigInt(raw.quoteSpentRaw),
        tokensLockedRaw: BigInt(raw.tokensLockedRaw), blockNumber: BigInt(raw.blockNumber) };
      const trade = hydrateCurveBuybackFromDecoded(row, context.venue, context.launch);
      const inserted = await tx.insert(trades).values({ chainId: trade.chainId, tokenAddress: trade.tokenAddress,
        venueId: trade.venueId, blockNumber: trade.blockNumber, blockHash: trade.blockHash, txHash: trade.txHash,
        logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side, tokenAmountRaw: trade.tokenAmountRaw.toString(),
        quoteAmountRaw: trade.quoteAmountRaw.toString(), quoteAssetAddress: trade.quoteAssetAddress,
        sourceEvent: trade.sourceEvent, activityKind: trade.activityKind, sourceLogId: null,
        priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
      }).onConflictDoNothing().returning({ txHash: trades.txHash });
      if (inserted.length) tradesWritten += 1;
    }

    const rawTransitions = (await envioPool.query(`SELECT * FROM ${tables.rawLifecycleTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLifecycleRow[];
    for (const raw of rawTransitions) {
      const row: EnvioRawLifecycleRow = { ...raw, blockNumber: BigInt(raw.blockNumber) };
      const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
      const inserted = await tx.insert(lifecycleTransitions).values({ sourceLogId: null,
        chainId: transition.chainId, tokenAddress: transition.tokenAddress, sourceId: 'pons-v2-lifecycle',
        phase: transition.phase, kind: transition.kind, blockNumber: transition.blockNumber,
        blockHash: transition.blockHash, txHash: transition.txHash, logIndex: transition.logIndex,
      }).onConflictDoNothing().returning({ txHash: lifecycleTransitions.txHash });
      if (inserted.length) transitionsWritten += 1;
    }

    // Rebuild the lifecycle projection after the reorg window was replaced. This also returns a
    // graduated launch to trading if its only transition vanished from Envio's canonical raw rows.
    await tx.execute(sql`UPDATE launches AS l SET lifecycle_status = COALESCE((
      SELECT CASE t.phase WHEN 1 THEN 'swept' WHEN 2 THEN 'graduated' WHEN 3 THEN 'rescued' END
      FROM lifecycle_transitions AS t WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address
      ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1
    ), 'trading') WHERE l.source_id = ${v2Factory.id}`);

    // Close (or reopen, if a sweep transition vanished on reorg) the curve venue's effective range —
    // the RPC-scan path does this at sweep time (be/src/db/repository.ts); this sync layer never did,
    // so officialVenues kept showing a swept/graduated token's curve as still open (final review,
    // Important 6).
    await tx.execute(sql`UPDATE venues AS v SET
      effective_to_block = (SELECT t.block_number FROM lifecycle_transitions AS t
        WHERE t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.phase = 1
        ORDER BY t.block_number, t.log_index LIMIT 1),
      effective_to_log_index = (SELECT t.log_index FROM lifecycle_transitions AS t
        WHERE t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.phase = 1
        ORDER BY t.block_number, t.log_index LIMIT 1)
      WHERE v.source_id = 'pons-v2-curve' AND v.kind = 'curve'`);

    const status = processedBlock >= headBlock ? 'caught_up' : 'backfilling';
    for (const id of [v2Factory.id, 'pons-v2-curve', 'pons-v2-lifecycle']) {
      await tx.update(sources).set({ confirmedToBlock: processedBlock, scannedToBlock: processedBlock, status })
        .where(eq(sources.id, id));
    }
  });
  for (const asset of newQuoteAssets) {
    await enqueueFeedResolutionJob(appDb.$client, asset.chainId, asset.quoteAssetAddress).catch(() => { /* best-effort; a later cycle's launch sharing the same quote asset will enqueue again */ });
  }
  return { launchesWritten, tradesWritten, transitionsWritten };
}
