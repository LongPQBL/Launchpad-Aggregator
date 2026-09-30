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
import { eligibleVenues } from './eligibleVenues.js';

export interface TradeSourceDefinition { source: LogSource; venueKind: VenueKind; factoryAddress: Address; version: string; factorySourceIds: readonly string[] }

// Trade sources moved to Validation Cloud (see README.md, 2026-09-30) after the free public RPC
// proved permanently unreliable for them. Validation Cloud has no hard address-count limit found
// so far (a single call with all 68,456 known pons-v1-active pool addresses succeeded), but a very
// large address list makes each call slow (~22.6s for 68,456 addresses vs ~5s for 5,000) — 5,000
// keeps each call reasonably fast while still needing far fewer groups than the old public RPC's
// 1000-selector hard cap required.
export const MAX_ADDRESSES_PER_LOG_QUERY = 5_000;

// Measured 2026-09-30 against Validation Cloud: 14 concurrent 5,000-address getLogs calls (the
// real group count pons-v1-active-trades needs) succeeded repeatedly with zero errors in ~7-9s
// total. The old cap of 4 forced that into ~4 sequential rounds for no measured benefit.
export const TRADE_LOG_GROUP_CONCURRENCY = 20;

// A source small enough to fit in one call (<= MAX_ADDRESSES_PER_LOG_QUERY) stays as one group —
// measured 2026-09-30: splitting 1,385 addresses into 20 tiny groups (3.35s) was no faster than
// one group (3.28s). Past that point, splitting is happening anyway, so use the smallest group
// size that still fits within TRADE_LOG_GROUP_CONCURRENCY concurrent calls rather than always
// maxing out each group — measured 3,462-address groups (20 groups, one concurrent round) at
// 5.9s vs 5,000-address groups (14 groups, still one round) at 7-9s for the same 69,227-address
// source, i.e. more smaller concurrent calls beat fewer larger ones once concurrency has headroom.
export function computeGroupSize(addressCount: number): number {
  if (addressCount <= MAX_ADDRESSES_PER_LOG_QUERY) return Math.max(1, addressCount);
  return Math.min(MAX_ADDRESSES_PER_LOG_QUERY, Math.ceil(addressCount / TRADE_LOG_GROUP_CONCURRENCY));
}

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

export function withVenueAddresses(definition: TradeSourceDefinition, contexts: readonly VenueContext[],
  range?: { fromBlock: bigint; toBlock: bigint }): LogSource {
  const selected = range ? eligibleVenues(contexts, range.fromBlock, range.toBlock) : contexts;
  return { ...definition.source, addresses: [...new Set(selected.map((context) => context.venue.ref.toLowerCase() as Address))] };
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
  await Promise.all(Array.from({ length: Math.min(TRADE_LOG_GROUP_CONCURRENCY, groups.length) }, async () => {
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
