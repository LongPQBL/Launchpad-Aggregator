import { decodeEventLog, toEventSelector, type Address, type Hash } from 'viem';
import { logKey } from '../../../domain/ids.js';
import type { FactorySource } from '../sourceRegistry.js';
import type { RpcLog } from '../v1/adapter.js';
import { launchGraduationRescuedEvent, launchSweptEvent, poolGraduatedEvent } from './abi.js';

export interface V2LifecycleEvent {
  tokenAddress: Address;
  phase: 1 | 2 | 3;
  kind: 'swept' | 'graduated' | 'rescued';
  sourceLogId: string;
  blockNumber: bigint;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
}

const events = [
  { event: launchSweptEvent, phase: 1, kind: 'swept' },
  { event: poolGraduatedEvent, phase: 2, kind: 'graduated' },
  { event: launchGraduationRescuedEvent, phase: 3, kind: 'rescued' },
] as const;

export function decodeV2LifecycleLog(log: RpcLog, factory: FactorySource): V2LifecycleEvent | null {
  if (factory.version !== 'v2' || log.address.toLowerCase() !== factory.factory.toLowerCase()) {
    throw new Error('Log does not match the pons v2 factory');
  }
  const match = events.find(({ event }) => log.topics[0] === toEventSelector(event));
  if (!match) return null;
  const decoded = decodeEventLog({ abi: [match.event], data: log.data,
    topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  return {
    tokenAddress: decoded.args.token.toLowerCase() as Address,
    phase: match.phase,
    kind: match.kind,
    sourceLogId: logKey(factory.chainId, log.blockHash, log.transactionHash, log.logIndex),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}
