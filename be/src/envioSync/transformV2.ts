import { zeroAddress, type Address, type Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import { hydrateV2Launch, type V2LaunchEvent, type V2LaunchRecord, type V2LaunchWithVenue } from '../launchpads/pons/v2/adapter.js';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';
import type { ExtendedLaunchMetadata } from '../launchpads/pons/extendedMetadata.js';
import type { Launch, Trade, Venue } from '../domain/types.js';

export interface EnvioRawLaunchV2Row {
  chainId: number;
  tokenAddress: string;
  curveAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export function envioRawLaunchV2ToEvent(row: EnvioRawLaunchV2Row): V2LaunchEvent {
  return {
    tokenAddress: row.tokenAddress.toLowerCase() as Address,
    curveAddress: row.curveAddress.toLowerCase() as Address,
    deployerAddress: row.deployerAddress.toLowerCase() as Address,
    pairToken: row.pairTokenAddress.toLowerCase() as Address,
    blockNumber: row.blockNumber,
    transactionHash: row.txHash.toLowerCase() as Hash,
    sourceLogId: logKey(row.chainId, row.blockHash.toLowerCase() as Hash, row.txHash.toLowerCase() as Hash, row.logIndex),
  };
}

// Metadata and quote asset are supplied by the caller from RPC or a stored launch.
// The factory record is reconstructed from event fields; its pool fee and tick spacing
// remain unavailable here and are not used for the current sync path.
export function hydrateV2LaunchFromEnvio(
  event: V2LaunchEvent, factory: FactorySource,
  metadata: { name: string; symbol: string; decimals: number },
  quoteAsset: { address: Address; symbol: string; decimals: number },
  extended?: ExtendedLaunchMetadata,
): V2LaunchWithVenue {
  const record: V2LaunchRecord = {
    token: event.tokenAddress, curve: event.curveAddress, deployer: event.deployerAddress,
    pairToken: event.pairToken, poolFee: 0, tickSpacing: 60, phase: 0, exists: true,
  };
  return hydrateV2Launch(event, factory, record, metadata, quoteAsset, extended);
}

// Same zero-address-means-native-ETH rule as resolveV2QuoteAsset (be/src/launchpads/pons/v2/adapter.ts)
// — that one case is knowable with zero RPC calls (per CLAUDE.md's "null means unavailable", this
// project never fakes a value it could instead just know or omit). Any real ERC20 pairToken's
// symbol/decimals are genuinely unknown without a metadata RPC call this phase doesn't make; real V2
// launches quote in tokens with decimals other than 18 (found live: USDG has 6, cbBTC has 8), so a
// universal placeholder would silently corrupt any volume computed from staging for those launches.
export function resolveKnownQuoteAsset(pairToken: Address): { symbol: string; decimals: number } | null {
  return pairToken.toLowerCase() === zeroAddress.toLowerCase() ? { symbol: 'ETH', decimals: 18 } : null;
}

export interface EnvioRawCurveTradeRow {
  curveAddress: string;
  side: 'buy' | 'sell';
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  feeRaw: bigint;
  taxRaw: bigint;
  txFrom: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

export interface EnvioRawCurveBuybackRow {
  curveAddress: string;
  quoteSpentRaw: bigint;
  tokensLockedRaw: bigint;
  txFrom: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

// Mirrors decodeCurveTrade's output shape (be/src/launchpads/pons/v2/adapter.ts) but Envio already
// decoded and side/leg-mapped the event (see envio/src/EventHandlers.ts's CurveBuy/CurveSell
// handlers), so there is no raw log to re-decode here. Price stays null — see this plan's Global
// Constraints (matches current production behavior, which never computes curve trade price either).
export function hydrateCurveTradeFromDecoded(row: EnvioRawCurveTradeRow, venue: Venue, launch: Launch): Trade {
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id,
    blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash, logIndex: row.logIndex, timestamp: row.timestamp,
    side: row.side, tokenAmountRaw: row.tokenAmountRaw, quoteAmountRaw: row.quoteAmountRaw,
    quoteAssetAddress: launch.quoteAsset.address,
    sourceEvent: row.side === 'buy' ? 'CurveBuy' : 'CurveSell',
    activityKind: 'user_trade',
    priceNumeratorRaw: null, priceDenominatorRaw: null,
    traderAddress: row.txFrom.toLowerCase() as Address,
  };
}

export function hydrateCurveBuybackFromDecoded(row: EnvioRawCurveBuybackRow, venue: Venue, launch: Launch): Trade {
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id,
    blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash, logIndex: row.logIndex, timestamp: row.timestamp,
    side: 'buy', tokenAmountRaw: row.tokensLockedRaw, quoteAmountRaw: row.quoteSpentRaw,
    quoteAssetAddress: launch.quoteAsset.address, sourceEvent: 'BuybackLocked', activityKind: 'protocol_buyback',
    priceNumeratorRaw: null, priceDenominatorRaw: null,
    traderAddress: row.txFrom.toLowerCase() as Address,
  };
}
