import type { Log } from 'viem';
import type { IndexBatch } from '../domain/types.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { decodeV1FactoryBatch, type RpcLog, type V1LaunchEvent, type V1TokenMetadata } from '../launchpads/pons/v1/adapter.js';
import { decodeV2FactoryBatch, type V2LaunchEvent, type V2LaunchRecord } from '../launchpads/pons/v2/adapter.js';
import type { QuoteAsset } from '../domain/types.js';
import type { LogSource } from './scan.js';

export interface FactoryStateLoaders {
  loadV1(event: V1LaunchEvent, factoryId: string): Promise<{ metadata: V1TokenMetadata; graduated: boolean }>;
  loadV2(event: V2LaunchEvent): Promise<{ record: V2LaunchRecord; metadata: { name: string; symbol: string; decimals: number }; quoteAsset: QuoteAsset }>;
}

function verifiedLog(log: Log): RpcLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error('Pending log cannot be indexed');
  }
  return { address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
    blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex };
}

export function createFactoryDecoder(loaders: FactoryStateLoaders) {
  return async (logs: readonly Log[], source: LogSource): Promise<IndexBatch> => {
    const factory = getPonsFactorySources().find((candidate) => candidate.id === source.id);
    if (!factory || source.chainId !== factory.chainId || source.addresses.length !== 1
      || source.addresses[0].toLowerCase() !== factory.factory.toLowerCase()) throw new Error(`Unknown factory source: ${source.id}`);
    const canonical = logs.map(verifiedLog);
    return factory.version === 'v1'
      ? decodeV1FactoryBatch(canonical, factory, (event) => loaders.loadV1(event, factory.id))
      : decodeV2FactoryBatch(canonical, factory, loaders.loadV2);
  };
}
