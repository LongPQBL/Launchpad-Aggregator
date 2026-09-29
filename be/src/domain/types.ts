import type { Address, Hash } from 'viem';

export type VenueKind = 'v3_pool' | 'curve' | 'v4_pool';
export type LifecycleStatus = 'trading' | 'swept' | 'graduated' | 'rescued';
export type ProtocolVersion = 'v1' | 'v2';
export type TradeSide = 'buy' | 'sell';
export type TradeActivityKind = 'user_trade' | 'protocol_buyback' | 'protocol_fee_conversion' | 'protocol_internal';
export type CoverageStatus = 'backfilling' | 'caught_up' | 'degraded';

export interface QuoteAsset {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface Launch {
  chainId: number;
  tokenAddress: Address;
  name: string;
  symbol: string;
  tokenDecimals: number;
  platform: 'pons';
  protocolVersion: ProtocolVersion;
  sourceId: string;
  sourceLogId: string;
  factoryAddress: Address;
  deployerAddress: Address;
  launchBlock: bigint;
  launchTxHash: Hash;
  quoteAsset: QuoteAsset;
  lifecycleStatus: LifecycleStatus;
}

export interface Venue {
  id: string;
  chainId: number;
  tokenAddress: Address;
  kind: VenueKind;
  ref: string;
  sourceId: string;
  sourceLogId: string;
  effectiveFromBlock: bigint;
  effectiveToBlock: bigint | null;
  official: boolean;
}

export interface Trade {
  chainId: number;
  tokenAddress: Address;
  venueId: string;
  blockNumber: bigint;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
  timestamp: number;
  side: TradeSide;
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  quoteAssetAddress: Address;
  sourceEvent: string;
  activityKind: TradeActivityKind;
  priceNumeratorRaw: bigint | null;
  priceDenominatorRaw: bigint | null;
}

export interface RawLog {
  chainId: number;
  sourceId: string;
  blockNumber: bigint;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
  address: Address;
  topics: readonly Hash[];
  data: Hash;
}

export interface IndexBatch {
  rawLogs: readonly RawLog[];
  launches: readonly Launch[];
  venues: readonly Venue[];
  trades: readonly Trade[];
}

export interface SourceCursor {
  sourceId: string;
  chainId: number;
  scannedToBlock: bigint;
  confirmedToBlock: bigint;
  status: CoverageStatus;
}
