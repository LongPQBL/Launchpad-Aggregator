import type { Address, Log } from 'viem';
import type { IndexBatch, VenueKind } from '../domain/types.js';
import type { GetBlocksData } from './blockData.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { decodeV1SwapBatch, type LaunchWithVenue, type RpcLog } from '../launchpads/pons/v1/adapter.js';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { decodeV2CurveBatch } from '../launchpads/pons/v2/adapter.js';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent } from '../launchpads/pons/v2/abi.js';
import type { LogSource } from './scan.js';
import type { VenueContext } from './venueStore.js';

export interface TradeSourceDefinition { source: LogSource; venueKind: VenueKind; factoryAddress: Address; version: string; factorySourceIds: readonly string[] }

export function getTradeSourceDefinitions(): TradeSourceDefinition[] {
  const factories = getPonsFactorySources();
  return [
    { source: { id: 'pons-v1-legacy-trades', chainId: 4663, startBlock: factories[0].startBlock,
      addresses: [], events: [v3SwapEvent] }, venueKind: 'v3_pool', factoryAddress: factories[0].factory,
    version: 'v1-trades', factorySourceIds: [factories[0].id] },
    { source: { id: 'pons-v1-active-trades', chainId: 4663, startBlock: factories[1].startBlock,
      addresses: [], events: [v3SwapEvent] }, venueKind: 'v3_pool', factoryAddress: factories[1].factory,
    version: 'v1-trades', factorySourceIds: [factories[1].id] },
    { source: { id: 'pons-v2-curve', chainId: 4663, startBlock: factories[2].startBlock,
      addresses: [], events: [curveBuyEvent, curveSellEvent, curveBuybackEvent] },
    venueKind: 'curve', factoryAddress: factories[2].factory, version: 'v2-curve', factorySourceIds: [factories[2].id] },
  ];
}

export function tradeFrontier(sourceId: string, factoryCursors: ReadonlyMap<string, bigint>): bigint {
  const ids = getTradeSourceDefinitions().find((definition) => definition.source.id === sourceId)?.factorySourceIds;
  if (!ids) throw new Error(`Unknown trade source: ${sourceId}`);
  const values = ids.map((id) => {
    const value = factoryCursors.get(id);
    if (value === undefined) throw new Error(`Missing factory cursor for ${sourceId}`);
    return value;
  });
  return values.reduce((lowest, value) => value < lowest ? value : lowest, values[0]);
}

export function withVenueAddresses(definition: TradeSourceDefinition, contexts: readonly VenueContext[]): LogSource {
  return { ...definition.source, addresses: [...new Set(contexts.map((context) => context.venue.ref.toLowerCase() as Address))] };
}

export async function getGroupedTradeLogs(source: LogSource, fromBlock: bigint, toBlock: bigint, maxAddresses: number,
  fetch: (group: LogSource, fromBlock: bigint, toBlock: bigint) => Promise<readonly Log[]>): Promise<Log[]> {
  if (!Number.isInteger(maxAddresses) || maxAddresses < 1) throw new Error('Invalid venue group size');
  const groups: LogSource[] = [];
  for (let index = 0; index < source.addresses.length; index += maxAddresses) {
    groups.push({ ...source, addresses: source.addresses.slice(index, index + maxAddresses) });
  }
  const results: Log[][] = Array.from({ length: groups.length }, () => []);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, async () => {
    while (next < groups.length) {
      const index = next++;
      results[index] = [...await fetch(groups[index], fromBlock, toBlock)];
    }
  }));
  return results.flat().sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

function verifiedLog(log: Log): RpcLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error('Pending trade log cannot be indexed');
  }
  return { address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
    blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex };
}

export function createTradeDecoder(contexts: readonly VenueContext[], getBlocksData: GetBlocksData) {
  const byAddress = new Map(contexts.map((context) => [context.venue.ref.toLowerCase(), context as LaunchWithVenue]));
  return async (logs: readonly Log[], source: LogSource): Promise<IndexBatch> => {
    const canonical = logs.map(verifiedLog);
    if (source.id === 'pons-v1-legacy-trades' || source.id === 'pons-v1-active-trades') {
      return decodeV1SwapBatch(canonical, source.id, byAddress, getBlocksData);
    }
    if (source.id === 'pons-v2-curve') return decodeV2CurveBatch(canonical, source.id, byAddress, getBlocksData);
    throw new Error(`Unknown trade source: ${source.id}`);
  };
}
