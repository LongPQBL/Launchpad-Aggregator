import { zeroAddress, type Address, type Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import { hydrateV2Launch, type V2LaunchEvent, type V2LaunchRecord, type V2LaunchWithVenue } from '../launchpads/pons/v2/adapter.js';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';
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

// hydrateV2Launch (be/src/launchpads/pons/v2/adapter.ts) validates its `record`/`metadata`/`quoteAsset`
// params against the event, sourced from factory-state RPC reads in the RPC-scan path. This phase's
// sync layer has no RPC calls (same scope decision as Phase 1's V1 launch handling), so the "record"
// is synthesized from the event's own fields as ground truth — this makes hydrateV2Launch's
// record-matches-event check a structural no-op here, same documented tradeoff as Phase 1's
// liquidityPool bypass. poolFee/tickSpacing are placeholders unused by this phase (no V4 logic here);
// Phase 3 will source real values directly from the V4 pool's own Initialize event instead of this
// placeholder. The launched token's own name/symbol are placeholders too — overwritten with null at
// the staging insert layer (see runSyncV2.ts), matching Phase 1's "null means unavailable"
// convention. The QUOTE asset's symbol/decimals are NOT simply nulled: runSyncV2.ts calls
// resolveKnownQuoteAsset (below) separately and writes its real answer when known (native ETH) or
// null when not, ignoring this function's own quoteAsset placeholder for that specific pair.
export function hydrateV2LaunchFromEnvio(event: V2LaunchEvent, factory: FactorySource): V2LaunchWithVenue {
  const record: V2LaunchRecord = {
    token: event.tokenAddress, curve: event.curveAddress, deployer: event.deployerAddress,
    pairToken: event.pairToken, poolFee: 0, tickSpacing: 60, phase: 0, exists: true,
  };
  return hydrateV2Launch(event, factory, record, { name: '', symbol: '', decimals: 18 },
    { address: event.pairToken, symbol: '', decimals: 18 });
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
