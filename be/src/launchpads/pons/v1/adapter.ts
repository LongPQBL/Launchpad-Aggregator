import { decodeEventLog, toEventSelector, type Address, type Hash } from 'viem';
import { logKey, venueKey } from '../../../domain/ids.js';
import type { IndexBatch, Launch, RawLog, Venue, Trade } from '../../../domain/types.js';
import { mapWithConcurrency, RPC_FETCH_CONCURRENCY } from '../../../indexer/concurrency.js';
import type { GetBlocksData } from '../../../indexer/blockData.js';
import type { FactorySource } from '../sourceRegistry.js';
import { v1LaunchEvent, v3SwapEvent } from './abi.js';

export interface RpcLog {
  address: Address;
  topics: readonly Hash[];
  data: Hash;
  blockNumber: bigint;
  blockHash: Hash;
  transactionHash: Hash;
  logIndex: number;
}

export interface V1LaunchEvent {
  tokenAddress: Address;
  deployerAddress: Address;
  pairToken: Address;
  poolAddress: Address;
  blockNumber: bigint;
  blockHash: Hash;
  transactionHash: Hash;
  logIndex: number;
  sourceLogId: string;
}

export interface V1TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  liquidityPool: Address;
}

export interface LaunchWithVenue {
  launch: Launch;
  venue: Venue;
}

const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;

export function decodeV1Launch(log: RpcLog, factory: FactorySource): V1LaunchEvent {
  if (factory.version !== 'v1' || log.address.toLowerCase() !== factory.factory.toLowerCase()) {
    throw new Error('Log does not match the pons v1 factory');
  }
  if (log.topics[0] !== factory.launchTopic) throw new Error('Log is not a pons v1 launch');
  const decoded = decodeEventLog({ abi: [v1LaunchEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  return {
    tokenAddress: decoded.args.token.toLowerCase() as Address,
    deployerAddress: decoded.args.deployer.toLowerCase() as Address,
    pairToken: decoded.args.pairToken.toLowerCase() as Address,
    poolAddress: decoded.args.pool.toLowerCase() as Address,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    sourceLogId: logKey(factory.chainId, log.blockHash, log.transactionHash, log.logIndex),
  };
}

export function hydrateV1Launch(event: V1LaunchEvent, factory: FactorySource, metadata: V1TokenMetadata, graduated: boolean): LaunchWithVenue {
  if (metadata.liquidityPool.toLowerCase() !== event.poolAddress.toLowerCase()) throw new Error('Token pool does not match factory log');
  if (event.pairToken.toLowerCase() !== weth.toLowerCase()) throw new Error('Unsupported pons v1 quote asset');
  const launch: Launch = {
    chainId: factory.chainId,
    tokenAddress: event.tokenAddress,
    name: metadata.name,
    symbol: metadata.symbol,
    tokenDecimals: metadata.decimals,
    platform: 'pons',
    protocolVersion: 'v1',
    sourceId: factory.id,
    sourceLogId: event.sourceLogId,
    factoryAddress: factory.factory,
    deployerAddress: event.deployerAddress,
    launchBlock: event.blockNumber,
    launchTxHash: event.transactionHash,
    quoteAsset: { address: weth, symbol: 'WETH', decimals: 18 },
    lifecycleStatus: graduated ? 'graduated' : 'trading',
  };
  const venue: Venue = {
    id: venueKey(factory.chainId, 'v3_pool', event.poolAddress),
    chainId: factory.chainId,
    tokenAddress: event.tokenAddress,
    kind: 'v3_pool',
    ref: event.poolAddress,
    sourceId: factory.id,
    sourceLogId: event.sourceLogId,
    effectiveFromBlock: event.blockNumber,
    effectiveToBlock: null,
    official: true,
  };
  return { launch, venue };
}

// Returns null for a dust swap (one leg rounds to exactly zero on a very small trade — real on-chain
// data, not corrupt input; see README.md's "Hai vấn đề khiến nguồn trade v1 kẹt vĩnh viễn" entry for
// verified examples). Callers must skip it as a non-trade rather than treat a null return as an error.
export function decodeV1Swap(log: RpcLog, venue: Venue, launch: Launch, timestamp: number, traderAddress: Address): Trade | null {
  if (venue.kind !== 'v3_pool' || !venue.official || log.address.toLowerCase() !== venue.ref.toLowerCase()) {
    throw new Error('Swap is not from the official V3 pool');
  }
  if (venue.chainId !== launch.chainId || venue.tokenAddress.toLowerCase() !== launch.tokenAddress.toLowerCase()) {
    throw new Error('Venue does not belong to launch');
  }
  if (log.topics[0] !== toEventSelector(v3SwapEvent)) throw new Error('Log is not a V3 swap');
  const decoded = decodeEventLog({ abi: [v3SwapEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  const tokenIsToken0 = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase();
  const tokenSigned = tokenIsToken0 ? decoded.args.amount0 : decoded.args.amount1;
  const pairSigned = tokenIsToken0 ? decoded.args.amount1 : decoded.args.amount0;
  if (tokenSigned === 0n || pairSigned === 0n) return null;
  if (tokenSigned * pairSigned > 0n) throw new Error('Invalid V3 swap amounts');
  const q192 = 2n ** 192n;
  const sqrtSquared = decoded.args.sqrtPriceX96 * decoded.args.sqrtPriceX96;
  if (sqrtSquared === 0n) throw new Error('Invalid V3 sqrt price');
  const decimalScale = 10n ** BigInt(launch.tokenDecimals);
  const quoteScale = 10n ** BigInt(launch.quoteAsset.decimals);
  return {
    chainId: launch.chainId,
    tokenAddress: launch.tokenAddress,
    venueId: venue.id,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    timestamp,
    side: pairSigned > 0n ? 'buy' : 'sell',
    tokenAmountRaw: tokenSigned < 0n ? -tokenSigned : tokenSigned,
    quoteAmountRaw: pairSigned < 0n ? -pairSigned : pairSigned,
    quoteAssetAddress: launch.quoteAsset.address,
    sourceEvent: 'Swap',
    activityKind: 'user_trade',
    priceNumeratorRaw: tokenIsToken0 ? sqrtSquared * decimalScale : q192 * decimalScale,
    priceDenominatorRaw: tokenIsToken0 ? q192 * quoteScale : sqrtSquared * quoteScale,
    traderAddress: traderAddress.toLowerCase() as Address,
  };
}

function toRawLog(log: RpcLog, chainId: number, sourceId: string): RawLog {
  return {
    chainId,
    sourceId,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    address: log.address,
    topics: log.topics,
    data: log.data,
  };
}

export async function decodeV1FactoryBatch(
  logs: readonly RpcLog[],
  factory: FactorySource,
  loadState: (event: V1LaunchEvent) => Promise<{ metadata: V1TokenMetadata; graduated: boolean }>,
): Promise<IndexBatch> {
  const events = logs.map((log) => decodeV1Launch(log, factory));
  const states = await mapWithConcurrency(events, RPC_FETCH_CONCURRENCY, loadState);
  const rawLogs: RawLog[] = [];
  const launches: Launch[] = [];
  const venues: Venue[] = [];
  for (let i = 0; i < logs.length; i++) {
    const result = hydrateV1Launch(events[i], factory, states[i].metadata, states[i].graduated);
    rawLogs.push(toRawLog(logs[i], factory.chainId, factory.id));
    launches.push(result.launch);
    venues.push(result.venue);
  }
  return { rawLogs, launches, venues, trades: [], transitions: [] };
}

export async function decodeV1SwapBatch(
  logs: readonly RpcLog[],
  sourceId: string,
  contexts: ReadonlyMap<string, LaunchWithVenue>,
  getBlocksData: GetBlocksData,
): Promise<IndexBatch> {
  const resolved = logs.map((log) => {
    const context = contexts.get(log.address.toLowerCase());
    if (!context) throw new Error(`Unknown official V3 pool: ${log.address}`);
    return { log, context };
  });
  const uniqueBlocks = [...new Set(resolved.map(({ log }) => log.blockNumber))];
  const blocks = await getBlocksData(uniqueBlocks);
  const rawLogs: RawLog[] = [];
  const trades: Trade[] = [];
  for (const { log, context } of resolved) {
    const data = blocks.get(log.blockNumber)!;
    const trader = data.traders.get(log.transactionHash)!;
    const trade = decodeV1Swap(log, context.venue, context.launch, data.timestamp, trader);
    if (trade) trades.push(trade);
    rawLogs.push(toRawLog(log, context.launch.chainId, sourceId));
  }
  return { rawLogs, launches: [], venues: [], trades, transitions: [] };
}
