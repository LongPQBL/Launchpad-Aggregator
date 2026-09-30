import type { Address, Hash } from 'viem';
import type { BlockTradeData, GetBlocksData } from './blockData.js';

interface RawBlockResult {
  timestamp: string;
  transactions: ReadonlyArray<{ hash: Hash; from: Address }>;
}
interface RpcBatchItem { id: number; error?: { message: string }; result?: RawBlockResult }

// Sends one JSON-RPC batch (array-of-requests) HTTP call per `batchSize` blocks instead of one
// call per block — this RPC accepts batches up to ~150 items but rejects larger ones with a
// single (non-array) error object rather than a per-item error, so that shape is handled
// explicitly here and surfaced as a normal Error whose message scan.ts's retry logic recognizes.
export function createBatchedGetBlockData(rpcUrl: string, batchSize: number, fetchImpl: typeof fetch = fetch): GetBlocksData {
  return async (blockNumbers) => {
    const result = new Map<bigint, BlockTradeData>();
    for (let start = 0; start < blockNumbers.length; start += batchSize) {
      const chunk = blockNumbers.slice(start, start + batchSize);
      const body = chunk.map((blockNumber, index) => ({
        jsonrpc: '2.0', id: index, method: 'eth_getBlockByNumber', params: [`0x${blockNumber.toString(16)}`, true],
      }));
      const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data: unknown = await response.json();
      if (!Array.isArray(data)) {
        const message = (data as { error?: { message?: string } })?.error?.message;
        throw new Error(message ?? `Unexpected batch RPC response: ${JSON.stringify(data).slice(0, 200)}`);
      }
      const byId = new Map((data as RpcBatchItem[]).map((item) => [item.id, item]));
      for (let i = 0; i < chunk.length; i++) {
        const item = byId.get(i);
        if (!item || item.error || !item.result) throw new Error(item?.error?.message ?? `Missing batch response for block ${chunk[i]}`);
        result.set(chunk[i], {
          timestamp: Number(BigInt(item.result.timestamp)),
          traders: new Map(item.result.transactions.map((tx) => [tx.hash, tx.from] as const)),
        });
      }
    }
    return result;
  };
}
