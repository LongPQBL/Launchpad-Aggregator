import type { Pool } from 'pg';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, hydrateCurveTradeFromDecoded, hydrateCurveBuybackFromDecoded,
  type EnvioRawLaunchV2Row, type EnvioRawCurveTradeRow, type EnvioRawCurveBuybackRow } from './transformV2.js';
import { envioRawLifecycleToTransition, type EnvioRawLifecycleRow } from './transformLifecycle.js';

const v2Factory = getPonsFactorySources()[2];

export interface EnvioV2TableNames {
  rawLaunchV2Table: string;
  rawCurveTradeTable: string;
  rawCurveBuybackTable: string;
  rawLifecycleTable: string;
}

export const DEFAULT_ENVIO_V2_TABLES: EnvioV2TableNames = {
  rawLaunchV2Table: 'envio."RawLaunchV2"',
  rawCurveTradeTable: 'envio."RawCurveTrade"',
  rawCurveBuybackTable: 'envio."RawCurveBuyback"',
  rawLifecycleTable: 'envio."RawLifecycleTransition"',
};

export async function syncV2Once(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV2TableNames = DEFAULT_ENVIO_V2_TABLES,
): Promise<{ launchesWritten: number; tradesWritten: number; transitionsWritten: number }> {
  const rawLaunches = (await envioPool.query(`SELECT * FROM ${tables.rawLaunchV2Table} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLaunchV2Row[];
  let launchesWritten = 0;
  const launchByCurve = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const event = envioRawLaunchV2ToEvent(row);
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory));
    } catch (error) {
      throw new Error(`Failed to sync V2 launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByCurve.set(event.curveAddress, { launch, venue });
    const inserted = await appDb.transaction(async (tx) => {
      const launchRows = await tx.insert(launchesEnvioStaging).values({
        chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: null, symbol: null,
        tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
        factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
        launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: null,
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
