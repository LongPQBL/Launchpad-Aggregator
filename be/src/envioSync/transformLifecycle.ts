import type { Address, Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import type { LifecycleTransition } from '../domain/types.js';

export interface EnvioRawLifecycleRow {
  chainId: number;
  tokenAddress: string;
  phase: 1 | 2 | 3;
  kind: 'swept' | 'graduated' | 'rescued';
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export function envioRawLifecycleToTransition(row: EnvioRawLifecycleRow, sourceId: string): LifecycleTransition {
  return {
    chainId: row.chainId,
    tokenAddress: row.tokenAddress.toLowerCase() as Address,
    sourceId,
    sourceLogId: logKey(row.chainId, row.blockHash.toLowerCase() as Hash, row.txHash.toLowerCase() as Hash, row.logIndex),
    phase: row.phase,
    kind: row.kind,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash,
    logIndex: row.logIndex,
  };
}
