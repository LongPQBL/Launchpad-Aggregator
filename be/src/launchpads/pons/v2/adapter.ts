import { decodeEventLog, parseAbi, toEventSelector, zeroAddress, type Address, type Hash } from 'viem';
import { logKey, venueKey } from '../../../domain/ids.js';
import type { IndexBatch, Launch, LifecycleStatus, QuoteAsset, RawLog, Trade, Venue } from '../../../domain/types.js';
import { mapWithConcurrency, TIMESTAMP_FETCH_CONCURRENCY } from '../../../indexer/concurrency.js';
import type { FactorySource } from '../sourceRegistry.js';
import type { RpcLog } from '../v1/adapter.js';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent, v2FactoryStateAbi, v2LaunchEvent } from './abi.js';
import type { CurveReserves } from './curve.js';

export interface V2LaunchRecord { token: Address; curve: Address; deployer: Address; pairToken: Address; poolFee: number; tickSpacing: number; phase: 0 | 1 | 2 | 3; exists: boolean }
export interface V2LaunchEvent { tokenAddress: Address; curveAddress: Address; deployerAddress: Address; pairToken: Address; blockNumber: bigint; transactionHash: Hash; sourceLogId: string }
export interface V2LaunchWithVenue { launch: Launch; venue: Venue }
export interface V2QuoteClient { readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown> }
export interface V2ReadClient { readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly Address[]; blockNumber?: bigint }): Promise<unknown> }

const erc20MetadataAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

export function decodeV2Launch(log: RpcLog, factory: FactorySource): V2LaunchEvent {
  if (factory.version !== 'v2' || !same(log.address, factory.factory)) throw new Error('Log does not match the pons v2 factory');
  if (log.topics[0] !== factory.launchTopic) throw new Error('Log is not a pons v2 launch');
  const decoded = decodeEventLog({ abi: [v2LaunchEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  return {
    tokenAddress: decoded.args.token.toLowerCase() as Address,
    curveAddress: decoded.args.curve.toLowerCase() as Address,
    deployerAddress: decoded.args.deployer.toLowerCase() as Address,
    pairToken: decoded.args.pairToken.toLowerCase() as Address,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    sourceLogId: logKey(factory.chainId, log.blockHash, log.transactionHash, log.logIndex),
  };
}

export function phaseToLifecycle(phase: 0 | 1 | 2 | 3): LifecycleStatus {
  switch (phase) {
    case 0: return 'trading';
    case 1: return 'swept';
    case 2: return 'graduated';
    case 3: return 'rescued';
  }
}

export function hydrateV2Launch(event: V2LaunchEvent, factory: FactorySource, record: V2LaunchRecord,
  metadata: { name: string; symbol: string; decimals: number }, quoteAsset: QuoteAsset): V2LaunchWithVenue {
  if (!record.exists || !same(record.token, event.tokenAddress) || !same(record.curve, event.curveAddress)
    || !same(record.deployer, event.deployerAddress) || !same(record.pairToken, event.pairToken)) {
    throw new Error('Pons v2 launch record does not match factory event');
  }
  if (!same(quoteAsset.address, event.pairToken)) throw new Error('Quote asset does not match pons v2 factory event');
  const launch: Launch = {
    chainId: factory.chainId, tokenAddress: event.tokenAddress, name: metadata.name, symbol: metadata.symbol,
    tokenDecimals: metadata.decimals, platform: 'pons', protocolVersion: 'v2', sourceId: factory.id,
    sourceLogId: event.sourceLogId, factoryAddress: factory.factory, deployerAddress: event.deployerAddress,
    launchBlock: event.blockNumber, launchTxHash: event.transactionHash, quoteAsset,
    lifecycleStatus: 'trading',
    v4PoolFee: record.poolFee, v4TickSpacing: record.tickSpacing,
  };
  const venue: Venue = {
    id: venueKey(factory.chainId, 'curve', event.curveAddress), chainId: factory.chainId,
    tokenAddress: event.tokenAddress, kind: 'curve', ref: event.curveAddress, sourceId: factory.id,
    sourceLogId: event.sourceLogId, effectiveFromBlock: event.blockNumber, effectiveToBlock: null, official: true,
  };
  return { launch, venue };
}

export async function resolveV2QuoteAsset(pairToken: Address, client: V2QuoteClient): Promise<QuoteAsset> {
  if (same(pairToken, zeroAddress)) return { address: zeroAddress, symbol: 'ETH', decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: pairToken, abi: erc20MetadataAbi, functionName: 'symbol' }),
    client.readContract({ address: pairToken, abi: erc20MetadataAbi, functionName: 'decimals' }),
  ]);
  if (typeof symbol !== 'string' || !symbol || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('Invalid pons v2 quote asset metadata');
  }
  return { address: pairToken, symbol, decimals };
}

export async function readV2TokenMetadata(client: V2QuoteClient, token: Address): Promise<{ name: string; symbol: string; decimals: number }> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'name' }),
    client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'decimals' }),
  ]);
  if (typeof name !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number'
    || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid pons v2 token metadata');
  return { name, symbol, decimals };
}

export async function readV2LaunchRecord(client: V2ReadClient, factory: Address, token: Address, blockNumber?: bigint): Promise<V2LaunchRecord> {
  const result = await client.readContract({
    address: factory, abi: v2FactoryStateAbi, functionName: 'getLaunchedToken', args: [token],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid pons v2 factory launch record');
  const value = result as Record<string, unknown>;
  if (typeof value.token !== 'string' || typeof value.curve !== 'string' || typeof value.deployer !== 'string'
    || typeof value.pairToken !== 'string' || typeof value.poolFee !== 'number' || typeof value.tickSpacing !== 'number'
    || ![0, 1, 2, 3].includes(value.phase as number) || typeof value.exists !== 'boolean') {
    throw new Error('Invalid pons v2 factory launch record');
  }
  return { token: value.token as Address, curve: value.curve as Address, deployer: value.deployer as Address,
    pairToken: value.pairToken as Address, poolFee: value.poolFee, tickSpacing: value.tickSpacing,
    phase: value.phase as 0 | 1 | 2 | 3, exists: value.exists };
}

export async function readV2Phase(client: V2ReadClient, factory: Address, token: Address, blockNumber?: bigint): Promise<0 | 1 | 2 | 3> {
  return (await readV2LaunchRecord(client, factory, token, blockNumber)).phase;
}

export function decodeCurveTrade(log: RpcLog, launch: Launch, venue: Venue, timestamp: number, verifiedPostTradeReserves?: CurveReserves): Trade {
  if (launch.protocolVersion !== 'v2' || venue.kind !== 'curve' || !venue.official || !same(log.address, venue.ref as Address)
    || venue.chainId !== launch.chainId || !same(venue.tokenAddress, launch.tokenAddress)) {
    throw new Error('Log is not from the official pons v2 curve');
  }
  const topic = log.topics[0];
  let side: 'buy' | 'sell';
  let tokenAmountRaw: bigint;
  let quoteAmountRaw: bigint;
  let sourceEvent: string;
  if (topic === toEventSelector(curveBuyEvent)) {
    const decoded = decodeEventLog({ abi: [curveBuyEvent], data: log.data, topics: [topic, ...log.topics.slice(1)], strict: true });
    side = 'buy'; tokenAmountRaw = decoded.args.tokensOut; quoteAmountRaw = decoded.args.quoteIn; sourceEvent = 'CurveBuy';
  } else if (topic === toEventSelector(curveSellEvent)) {
    const decoded = decodeEventLog({ abi: [curveSellEvent], data: log.data, topics: [topic, ...log.topics.slice(1)], strict: true });
    side = 'sell'; tokenAmountRaw = decoded.args.tokensIn; quoteAmountRaw = decoded.args.quoteOut; sourceEvent = 'CurveSell';
  } else throw new Error('Log is not a pons v2 curve trade');
  if (tokenAmountRaw <= 0n || quoteAmountRaw <= 0n) throw new Error('Invalid pons v2 curve trade amounts');
  if (verifiedPostTradeReserves && (verifiedPostTradeReserves.quote <= 0n || verifiedPostTradeReserves.token <= 0n)) {
    throw new Error('Invalid verified curve reserves');
  }
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id, blockNumber: log.blockNumber,
    blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex, timestamp, side, tokenAmountRaw,
    quoteAmountRaw, quoteAssetAddress: launch.quoteAsset.address, sourceEvent,
    activityKind: 'user_trade',
    priceNumeratorRaw: verifiedPostTradeReserves ? verifiedPostTradeReserves.quote * 10n ** BigInt(launch.tokenDecimals) : null,
    priceDenominatorRaw: verifiedPostTradeReserves ? verifiedPostTradeReserves.token * 10n ** BigInt(launch.quoteAsset.decimals) : null,
  };
}

export function decodeCurveBuyback(log: RpcLog, launch: Launch, venue: Venue, timestamp: number, verifiedPostTradeReserves?: CurveReserves): Trade {
  if (launch.protocolVersion !== 'v2' || venue.kind !== 'curve' || !venue.official || !same(log.address, venue.ref as Address)
    || venue.chainId !== launch.chainId || !same(venue.tokenAddress, launch.tokenAddress)
    || log.topics[0] !== toEventSelector(curveBuybackEvent)) {
    throw new Error('Log is not from the official pons v2 curve buyback');
  }
  const decoded = decodeEventLog({ abi: [curveBuybackEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  if (decoded.args.quoteSpent <= 0n || decoded.args.tokensLocked <= 0n) throw new Error('Invalid pons v2 curve buyback amounts');
  if (verifiedPostTradeReserves && (verifiedPostTradeReserves.quote <= 0n || verifiedPostTradeReserves.token <= 0n)) {
    throw new Error('Invalid verified curve reserves');
  }
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id, blockNumber: log.blockNumber,
    blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex, timestamp, side: 'buy',
    tokenAmountRaw: decoded.args.tokensLocked, quoteAmountRaw: decoded.args.quoteSpent,
    quoteAssetAddress: launch.quoteAsset.address, sourceEvent: 'BuybackLocked', activityKind: 'protocol_buyback',
    priceNumeratorRaw: verifiedPostTradeReserves ? verifiedPostTradeReserves.quote * 10n ** BigInt(launch.tokenDecimals) : null,
    priceDenominatorRaw: verifiedPostTradeReserves ? verifiedPostTradeReserves.token * 10n ** BigInt(launch.quoteAsset.decimals) : null,
  };
}

function toRawLog(log: RpcLog, chainId: number, sourceId: string): RawLog {
  return { chainId, sourceId, blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash,
    logIndex: log.logIndex, address: log.address, topics: log.topics, data: log.data };
}

export async function decodeV2FactoryBatch(logs: readonly RpcLog[], factory: FactorySource,
  loadState: (event: V2LaunchEvent) => Promise<{ record: V2LaunchRecord; metadata: { name: string; symbol: string; decimals: number }; quoteAsset: QuoteAsset }>): Promise<IndexBatch> {
  const rawLogs: RawLog[] = [];
  const launches: Launch[] = [];
  const venues: Venue[] = [];
  for (const log of logs) {
    const event = decodeV2Launch(log, factory);
    const state = await loadState(event);
    const result = hydrateV2Launch(event, factory, state.record, state.metadata, state.quoteAsset);
    rawLogs.push(toRawLog(log, factory.chainId, factory.id));
    launches.push(result.launch);
    venues.push(result.venue);
  }
  return { rawLogs, launches, venues, trades: [], transitions: [] };
}

export async function decodeV2CurveBatch(logs: readonly RpcLog[], sourceId: string,
  contexts: ReadonlyMap<string, V2LaunchWithVenue>, getTimestamp: (block: bigint) => Promise<number>): Promise<IndexBatch> {
  const resolved = logs.map((log) => {
    const context = contexts.get(log.address.toLowerCase());
    if (!context) throw new Error(`Unknown pons v2 curve: ${log.address}`);
    const isTradeEvent = log.topics[0] === toEventSelector(curveBuyEvent) || log.topics[0] === toEventSelector(curveSellEvent)
      || log.topics[0] === toEventSelector(curveBuybackEvent);
    return { log, context, isTradeEvent };
  });
  const uniqueBlocks = [...new Set(resolved.filter((item) => item.isTradeEvent).map((item) => item.log.blockNumber))];
  const timestamps = new Map(await mapWithConcurrency(uniqueBlocks, TIMESTAMP_FETCH_CONCURRENCY,
    async (blockNumber) => [blockNumber, await getTimestamp(blockNumber)] as const));
  const rawLogs: RawLog[] = [];
  const trades: Trade[] = [];
  for (const { log, context, isTradeEvent } of resolved) {
    rawLogs.push(toRawLog(log, context.launch.chainId, sourceId));
    if (!isTradeEvent) continue;
    const timestamp = timestamps.get(log.blockNumber)!;
    trades.push(log.topics[0] === toEventSelector(curveBuybackEvent)
      ? decodeCurveBuyback(log, context.launch, context.venue, timestamp)
      : decodeCurveTrade(log, context.launch, context.venue, timestamp));
  }
  return { rawLogs, launches: [], venues: [], trades, transitions: [] };
}
