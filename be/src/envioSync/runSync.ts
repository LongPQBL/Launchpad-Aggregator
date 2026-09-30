import type { Pool } from 'pg';
import type { Address } from 'viem';
import { hydrateV1Launch } from '../launchpads/pons/v1/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { envioRawLaunchToEvent, hydrateV1SwapFromDecoded, type EnvioRawLaunchRow, type EnvioRawSwapRow } from './transformV1Legacy.js';
import { readAllRawLaunches, readAllRawSwaps } from './envioDb.js';

const legacy = getPonsFactorySources()[0];

export interface EnvioTableNames {
  rawLaunchTable: string;
  rawSwapTable: string;
}

// Real, confirmed-empirically (Task 1 Step 7 / Task 2 Step 7) production table names — the default
// unless a caller (e.g. a test standing in a throwaway schema for Envio's own Postgres) overrides them.
export const DEFAULT_ENVIO_TABLES: EnvioTableNames = {
  rawLaunchTable: 'envio."RawLaunch"',
  rawSwapTable: 'envio."RawSwap"',
};

export async function syncV1LegacyOnce(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioTableNames = DEFAULT_ENVIO_TABLES,
): Promise<{ launchesWritten: number; tradesWritten: number }> {
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
    // Metadata/graduation state come from live RPC in the RPC-scanning path
    // (be/src/indexer/factoryRuntime.ts); this phase's staging tables intentionally omit that
    // enrichment — see spec section 8 (scope for Phase 1 is the launch/swap decode path only, not
    // the full metadata/graduation pipeline). liquidityPool is set to the event's own pool address
    // as ground truth, which means hydrateV1Launch's "token pool matches factory log" check is a
    // structural no-op here (it always trivially passes) — the real path checks this against the
    // token contract's own liquidityPool() read. tokenDecimals is hardcoded to 18 (most ERC20s on
    // this chain use it; a wrong value here would only mis-price a staging-only trade, never a real
    // one) since the price math genuinely needs a concrete decimals value and this phase has no
    // metadata RPC call to source a real one from.
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV1Launch(event, legacy, {
        name: '', symbol: '', decimals: 18, liquidityPool: event.poolAddress,
      }, false));
    } catch (error) {
      throw new Error(`Failed to sync launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByPool.set(event.poolAddress, { launch, venue });
    const inserted = await appDb.transaction(async (tx) => {
      const launchRows = await tx.insert(launchesEnvioStaging).values({
        chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: null, symbol: null,
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
