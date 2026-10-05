import type { Address, Hash } from 'viem';

export type VenueKind = 'v3_pool' | 'curve' | 'v4_pool';
export type LifecycleStatus = 'trading' | 'swept' | 'graduated' | 'rescued';
export type ProtocolVersion = 'v1' | 'v2';
export type TradeSide = 'buy' | 'sell';
export type TradeActivityKind = 'user_trade' | 'protocol_buyback' | 'protocol_fee_conversion' | 'protocol_internal';
export type CoverageStatus = 'backfilling' | 'caught_up' | 'degraded';

export interface QuoteAsset {
  address: Address;
  // null until a bounded enrichment job resolves an unknown ERC20 quote asset's symbol/decimals —
  // the known-native-ETH fast path (be/src/envioSync/transformV2.ts's resolveKnownQuoteAsset) never
  // needs this, so this is only ever unknown for a real ERC20 pair token.
  symbol: string | null;
  decimals: number | null;
}

export interface Launch {
  chainId: number;
  tokenAddress: Address;
  // null until a bounded enrichment job resolves the token's on-chain name/symbol/decimals — see
  // docs/superpowers/specs/2026-10-05-envio-near-realtime-sync-design.md's "Immediate launch records
  // and enrichment". Never coerce a missing value to an empty string or zero; a UI/valuation consumer
  // must treat null as unavailable, not a real value.
  name: string | null;
  symbol: string | null;
  tokenDecimals: number | null;
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
  v4PoolFee?: number | null;
  v4TickSpacing?: number | null;
  logoUri?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  launchTimestamp?: number | null;
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
  effectiveFromLogIndex?: number;
  effectiveToBlock: bigint | null;
  effectiveToLogIndex?: number | null;
  official: boolean;
}

export interface LifecycleTransition {
  chainId: number;
  tokenAddress: Address;
  sourceId: string;
  sourceLogId: string;
  phase: 1 | 2 | 3;
  kind: 'swept' | 'graduated' | 'rescued';
  blockNumber: bigint;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
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
  // The transaction's originating EOA (tx.origin), not the log's `sender`/`buyer` arg — on a V4
  // swap `sender` is typically the router contract, not the wallet that actually traded.
  traderAddress: Address;
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
  transitions: readonly LifecycleTransition[];
}

export interface SourceCursor {
  sourceId: string;
  chainId: number;
  scannedToBlock: bigint;
  confirmedToBlock: bigint;
  status: CoverageStatus;
}
