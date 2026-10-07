'use client';

import { useState } from 'react';
import type { Address } from 'viem';
import { useSendCalls, useWaitForCallsStatus, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { decodeTradeError } from './decodeTradeError';

export type TradeSubmissionStatus = 'idle' | 'pending' | 'confirming' | 'confirmed' | 'failed';

export interface TradeCall {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export interface TradeSubmission {
  submit: (call: TradeCall, options?: { onSuccess?: () => void }) => void;
  submitBatch: (calls: readonly TradeCall[], options?: { onSuccess?: () => void }) => void;
  status: TradeSubmissionStatus;
  txHash: Address | undefined;
  errorMessage: string | null;
}

export function useTradeSubmission(): TradeSubmission {
  // Tracks which of submit()/submitBatch() was most recently called, so status/txHash/errorMessage
  // read the right underlying hook's state — both useWriteContract and useSendCalls' mutation state
  // persist across renders once used, so "a batch was sent at some point" is not a reliable signal
  // that the *latest* submission was a batch (e.g. a second swap of an already-approved token goes
  // through submit(), not submitBatch(), even in a panel that used submitBatch() once before).
  const [mode, setMode] = useState<'single' | 'batch'>('single');

  const { writeContract, status: writeStatus, error: writeError, data: writeHash } = useWriteContract();
  const { status: receiptStatus, error: receiptError } = useWaitForTransactionReceipt({ hash: writeHash, query: { enabled: Boolean(writeHash) } });

  const { sendCalls, status: sendStatus, error: sendError, data: sendData } = useSendCalls();
  const { data: callsStatus, error: callsStatusError } = useWaitForCallsStatus({ id: sendData?.id, query: { enabled: Boolean(sendData?.id) } });

  function submit(call: TradeCall, options?: { onSuccess?: () => void }) {
    setMode('single');
    // writeContract's real type is generic over the ABI for literal-argument inference; TradeCall's
    // simpler shape loses that inference, so this call needs a loose cast at this single internal
    // boundary. Every real call site still passes a concrete object literal, which is what actually
    // matters for correctness.
    writeContract(call as never, options);
  }

  function submitBatch(calls: readonly TradeCall[], options?: { onSuccess?: () => void }) {
    setMode('batch');
    sendCalls({ calls } as never, options);
  }

  let status: TradeSubmissionStatus = 'idle';
  let txHash: Address | undefined;
  let errorMessage: string | null = null;

  if (mode === 'batch') {
    if (sendStatus === 'pending') status = 'pending';
    else if (sendStatus === 'error') status = 'failed';
    else if (sendStatus === 'success') {
      if (!callsStatus) status = 'confirming';
      else if (callsStatus.status === 'success') status = 'confirmed';
      else if (callsStatus.status === 'failure') status = 'failed';
      else status = 'confirming';
    }
    txHash = callsStatus?.receipts?.[callsStatus.receipts.length - 1]?.transactionHash;
    const reportedError = callsStatusError ?? sendError;
    errorMessage = reportedError ? decodeTradeError(reportedError) : null;
  } else {
    if (writeStatus === 'pending') status = 'pending';
    else if (writeStatus === 'error') status = 'failed';
    else if (writeStatus === 'success') status = receiptStatus === 'success' ? 'confirmed' : receiptStatus === 'error' ? 'failed' : 'confirming';
    txHash = writeHash;
    const reportedError = receiptError ?? writeError;
    errorMessage = reportedError ? decodeTradeError(reportedError) : null;
  }

  return { submit, submitBatch, status, txHash, errorMessage };
}
