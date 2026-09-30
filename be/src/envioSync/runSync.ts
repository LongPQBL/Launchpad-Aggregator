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

export async function syncV1LegacyOnce(envioPool: Pool, appDb: Database): Promise<{ launchesWritten: number; tradesWritten: number }> {
  const rawLaunches = await readAllRawLaunches(envioPool);
  const existingLaunches = new Set(
    (await appDb.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging))
      .map((row) => row.tokenAddress),
  );
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
    // Metadata/graduation state come from live RPC in the RPC-scanning path (be/src/indexer/factoryRuntime.ts);
    // this phase's staging tables intentionally omit that enrichment — see spec section 8 (scope for
    // Phase 1 is the launch/swap decode path only, not the full metadata/graduation pipeline).
    const { launch, venue } = hydrateV1Launch(event, legacy, {
      name: '', symbol: '', decimals: 18, liquidityPool: event.poolAddress,
    }, false);
    launchByPool.set(event.poolAddress, { launch, venue });
    if (existingLaunches.has(launch.tokenAddress)) continue;
    await appDb.insert(launchesEnvioStaging).values({
      chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name, symbol: launch.symbol,
      tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
      factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
      launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
      quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
    }).onConflictDoNothing();
    await appDb.insert(venuesEnvioStaging).values({
      id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
      effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
    }).onConflictDoNothing();
    launchesWritten += 1;
  }

  const rawSwaps = await readAllRawSwaps(envioPool);
  const existingTrades = new Set(
    (await appDb.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex }).from(tradesEnvioStaging))
      .map((row) => `${row.txHash}:${row.logIndex}`),
  );
  let tradesWritten = 0;
  for (const raw of rawSwaps) {
    const context = launchByPool.get(raw.poolAddress.toLowerCase());
    if (!context) continue;
    const key = `${raw.txHash.toLowerCase()}:${raw.logIndex}`;
    if (existingTrades.has(key)) continue;
    const row: EnvioRawSwapRow = {
      poolAddress: raw.poolAddress, sender: raw.sender, recipient: raw.recipient,
      amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1), sqrtPriceX96: BigInt(raw.sqrtPriceX96),
      liquidity: BigInt(raw.liquidity), tick: raw.tick, blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash, txHash: raw.txHash, logIndex: raw.logIndex, timestamp: raw.timestamp,
    };
    const trade = hydrateV1SwapFromDecoded(row, context.venue, context.launch, raw.sender as Address);
    if (!trade) continue;
    await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
    }).onConflictDoNothing();
    tradesWritten += 1;
  }
  return { launchesWritten, tradesWritten };
}
