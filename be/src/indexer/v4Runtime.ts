import { isHash, type Address, type Hash, type Log } from 'viem';
import type { IndexBatch, RawLog } from '../domain/types.js';
import type { RpcLog } from '../launchpads/pons/v1/adapter.js';
import { decodePonsV4Swap, v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import type { GetBlocksData } from './blockData.js';
import type { LogSource, ScanDeps } from './scan.js';
import type { VenueContext } from './venueStore.js';

export interface V4PoolSource extends LogSource { poolId: Hash }

export function getV4PoolSources(contexts: readonly VenueContext[], poolManager: Address): V4PoolSource[] {
  return contexts.map(({ launch, venue }) => {
    if (launch.chainId !== 4663 || launch.protocolVersion !== 'v2' || venue.kind !== 'v4_pool' || !venue.official
      || venue.chainId !== launch.chainId || venue.tokenAddress.toLowerCase() !== launch.tokenAddress.toLowerCase()
      || !isHash(venue.ref) || venue.ref.length !== 66) {
      throw new Error('Invalid official Pons V4 venue');
    }
    const poolId = venue.ref.toLowerCase() as Hash;
    return { id: `pons-v2-v4:${poolId}`, chainId: launch.chainId, startBlock: venue.effectiveFromBlock,
      addresses: [poolManager], events: [v4SwapEvent], poolId };
  });
}

export function createV4GetLogs(client: { getLogs(parameters: {
  address: Address; event: typeof v4SwapEvent; args: { id: Hash }; fromBlock: bigint; toBlock: bigint;
}): Promise<readonly Log[]> }, poolManager: Address, poolId: Hash): ScanDeps['getLogs'] {
  return async (source, fromBlock, toBlock) => {
    if (source.id !== `pons-v2-v4:${poolId.toLowerCase()}` || source.addresses.length !== 1
      || source.addresses[0].toLowerCase() !== poolManager.toLowerCase()) throw new Error('Unknown Pons V4 swap source');
    return client.getLogs({ address: poolManager, event: v4SwapEvent, args: { id: poolId }, fromBlock, toBlock });
  };
}

function verifiedLog(log: Log): RpcLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error('Pending V4 swap log cannot be indexed');
  }
  return { address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
    blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex };
}

export function createV4TradeDecoder(context: VenueContext, getBlocksData: GetBlocksData,
  poolManager: Address, hook: Address): ScanDeps['decodeLogs'] {
  const poolId = context.venue.ref.toLowerCase() as Hash;
  const sourceId = `pons-v2-v4:${poolId}`;
  return async (logs, source): Promise<IndexBatch> => {
    if (source.id !== sourceId || source.chainId !== context.launch.chainId) throw new Error('Wrong Pons V4 source');
    const verifiedLogs = logs.map((input) => {
      const log = verifiedLog(input);
      if (log.blockNumber < context.venue.effectiveFromBlock
        || (log.blockNumber === context.venue.effectiveFromBlock
          && log.logIndex < (context.venue.effectiveFromLogIndex ?? 0))) {
        throw new Error('V4 swap precedes official venue Initialize position');
      }
      return log;
    });
    const uniqueBlocks = [...new Set(verifiedLogs.map((log) => log.blockNumber))];
    const blocks = await getBlocksData(uniqueBlocks);
    const rawLogs: RawLog[] = [];
    const trades: IndexBatch['trades'][number][] = [];
    for (const log of verifiedLogs) {
      const data = blocks.get(log.blockNumber)!;
      const trader = data.traders.get(log.transactionHash)!;
      const trade = decodePonsV4Swap(log, poolId, context.launch, context.venue, data.timestamp, trader, poolManager, hook);
      if (!trade) continue;
      trades.push(trade);
      rawLogs.push({ chainId: source.chainId, sourceId, blockNumber: log.blockNumber, blockHash: log.blockHash,
        txHash: log.transactionHash, logIndex: log.logIndex, address: log.address, topics: log.topics, data: log.data });
    }
    return { rawLogs, launches: [], venues: [], trades, transitions: [] };
  };
}
