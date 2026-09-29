import { isAddress, parseAbi, type Address, type Hash, type Log } from 'viem';
import { logKey } from '../domain/ids.js';
import type { IndexBatch, RawLog, Venue } from '../domain/types.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { RpcLog } from '../launchpads/pons/v1/adapter.js';
import { launchGraduationRescuedEvent, launchSweptEvent, poolGraduatedEvent } from '../launchpads/pons/v2/abi.js';
import { decodeV2LifecycleLog } from '../launchpads/pons/v2/lifecycle.js';
import { derivePonsV4PoolId, transitionOfficialVenue, verifyPonsV4PoolInitialization } from '../launchpads/pons/v2/poolKey.js';
import type { VenueContext } from './venueStore.js';
import type { LogSource, ScanDeps } from './scan.js';

const factory = getPonsFactorySources().find((source) => source.version === 'v2')!;
const expectedPoolManager = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const expectedHook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const factoryPoolsAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function memeHook() view returns (address)',
]);

export function lifecycleTarget(factoryCursor: bigint, safeHead: bigint): bigint {
  return factoryCursor < safeHead ? factoryCursor : safeHead;
}

export async function readV2FactoryPoolConfig(client: { readContract(parameters: {
  address: Address; abi: readonly unknown[]; functionName: string;
}): Promise<unknown> }): Promise<{ poolManager: Address; hook: Address }> {
  const [poolManager, hook] = await Promise.all([
    client.readContract({ address: factory.factory, abi: factoryPoolsAbi, functionName: 'poolManager' }),
    client.readContract({ address: factory.factory, abi: factoryPoolsAbi, functionName: 'memeHook' }),
  ]);
  if (typeof poolManager !== 'string' || typeof hook !== 'string' || !isAddress(poolManager) || !isAddress(hook)
    || poolManager.toLowerCase() !== expectedPoolManager || hook.toLowerCase() !== expectedHook) {
    throw new Error('Pons V2 factory pool dependencies do not match audited Robinhood addresses');
  }
  return { poolManager: poolManager.toLowerCase() as Address, hook: hook.toLowerCase() as Address };
}

export function getV2LifecycleSource(): LogSource {
  return { id: 'pons-v2-lifecycle', chainId: factory.chainId, startBlock: factory.startBlock,
    addresses: [factory.factory], events: [launchSweptEvent, poolGraduatedEvent, launchGraduationRescuedEvent] };
}

export interface LifecycleDecoderDeps {
  loadLaunch(token: Address): Promise<VenueContext | null>;
  getReceiptLogs(txHash: Hash): Promise<readonly RpcLog[]>;
  poolManager: Address;
  hook: Address;
}

function verifiedLog(log: Log): RpcLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error('Pending lifecycle log cannot be indexed');
  }
  return { address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
    blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex };
}

function rawLog(log: RpcLog, sourceId: string): RawLog {
  return { chainId: factory.chainId, sourceId, blockNumber: log.blockNumber, blockHash: log.blockHash,
    txHash: log.transactionHash, logIndex: log.logIndex, address: log.address, topics: log.topics, data: log.data };
}

export function createLifecycleDecoder(deps: LifecycleDecoderDeps): ScanDeps['decodeLogs'] {
  return async (logs, source): Promise<IndexBatch> => {
    if (source.id !== 'pons-v2-lifecycle' || source.chainId !== factory.chainId
      || source.addresses.length !== 1 || source.addresses[0].toLowerCase() !== factory.factory.toLowerCase()) {
      throw new Error('Unknown Pons V2 lifecycle source');
    }
    const rawLogs: RawLog[] = [];
    const transitions: IndexBatch['transitions'][number][] = [];
    const venues: Venue[] = [];
    for (const input of logs) {
      const log = verifiedLog(input);
      const event = decodeV2LifecycleLog(log, factory);
      if (!event) continue;
      const context = await deps.loadLaunch(event.tokenAddress);
      if (!context || context.launch.protocolVersion !== 'v2' || context.venue.kind !== 'curve'
        || context.launch.chainId !== factory.chainId || context.launch.tokenAddress.toLowerCase() !== event.tokenAddress
        || context.venue.tokenAddress.toLowerCase() !== event.tokenAddress) {
        throw new Error(`Unknown launch for Pons V2 lifecycle token ${event.tokenAddress}`);
      }
      rawLogs.push(rawLog(log, source.id));
      if (event.phase === 2) {
        const terms = { fee: context.launch.v4PoolFee, tickSpacing: context.launch.v4TickSpacing };
        if (terms.fee === null || terms.fee === undefined || terms.tickSpacing === null || terms.tickSpacing === undefined) {
          throw new Error('Missing Pons V2 pool terms');
        }
        const poolId = derivePonsV4PoolId(context.launch, { fee: terms.fee, tickSpacing: terms.tickSpacing }, deps.hook);
        const candidates = await deps.getReceiptLogs(log.transactionHash);
        const initialization = candidates.find((candidate) => verifyPonsV4PoolInitialization(candidate, log,
          context.launch, { fee: terms.fee!, tickSpacing: terms.tickSpacing! }, deps.hook, deps.poolManager));
        if (!initialization) throw new Error(`No matching Pons V4 Initialize for ${event.tokenAddress}`);
        rawLogs.push(rawLog(initialization, source.id));
        venues.push(transitionOfficialVenue(context.launch, context.venue, 2,
          { blockNumber: initialization.blockNumber, logIndex: initialization.logIndex },
          { poolId, sourceId: source.id,
            sourceLogId: logKey(factory.chainId, initialization.blockHash, initialization.transactionHash, initialization.logIndex) }).openedPool!);
      }
      transitions.push({ ...event, sourceId: source.id, chainId: factory.chainId });
    }
    rawLogs.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
    return { rawLogs, launches: [], venues, trades: [], transitions };
  };
}
