'use client';

import type { Address } from 'viem';
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { decodeTradeError } from './decodeTradeError';

export type TradeSubmissionStatus = 'idle' | 'pending' | 'confirming' | 'confirmed' | 'failed';

export interface TradeSubmission {
  submit: ReturnType<typeof useWriteContract>['writeContract'];
  status: TradeSubmissionStatus;
  txHash: Address | undefined;
  errorMessage: string | null;
}

export function useTradeSubmission(): TradeSubmission {
  const { writeContract, status: writeStatus, error, data: txHash } = useWriteContract();
  const { status: receiptStatus } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: Boolean(txHash) } });

  let status: TradeSubmissionStatus = 'idle';
  if (writeStatus === 'pending') status = 'pending';
  else if (writeStatus === 'error') status = 'failed';
  else if (writeStatus === 'success') status = receiptStatus === 'success' ? 'confirmed' : receiptStatus === 'error' ? 'failed' : 'confirming';

  return {
    submit: writeContract,
    status,
    txHash,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
