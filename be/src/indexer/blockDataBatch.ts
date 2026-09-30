import type { Address, Hash } from 'viem';
import type { BlockTradeData, GetBlocksData } from './blockData.js';

interface RawBlockResult {
  timestamp: string;
  transactions: ReadonlyArray<{ hash: Hash; from: Address }>;
}
interface RpcBatchItem { id: number; error?: { message: string }; result?: RawBlockResult }

// Sends one JSON-RPC batch (array-of-requests) HTTP call per `batchSize` blocks instead of one
// call per block. Bound concurrency lets a dedicated RPC overlap batch latency without allowing
// unbounded requests; responses are assembled in input order regardless of completion order.
export function createBatchedGetBlockData(rpcUrl: string, batchSize: number, fetchImpl: typeof fetch = fetch,
  concurrency = 1): GetBlocksData {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('Invalid block batch concurrency');
  }
  return async (blockNumbers) => {
    const chunks: bigint[][] = [];
    for (let start = 0; start < blockNumbers.length; start += batchSize) {
      chunks.push(blockNumbers.slice(start, start + batchSize));
    }
    const results: BlockTradeData[][] = Array.from({ length: chunks.length }, () => []);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      while (next < chunks.length) {
        const index = next++;
        const chunk = chunks[index];
        const body = chunk.map((blockNumber, item) => ({
          jsonrpc: '2.0', id: item, method: 'eth_getBlockByNumber', params: [`0x${blockNumber.toString(16)}`, true],
        }));
        const response = await fetchImpl(rpcUrl,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data: unknown = await response.json();
        if (!Array.isArray(data)) {
          const message = (data as { error?: { message?: string } })?.error?.message;
          throw new Error(message ?? `Unexpected batch RPC response: ${JSON.stringify(data).slice(0, 200)}`);
        }
        const byId = new Map((data as RpcBatchItem[]).map((item) => [item.id, item]));
        const parsed: BlockTradeData[] = [];
        for (let i = 0; i < chunk.length; i++) {
          const item = byId.get(i);
          if (!item || item.error || !item.result) throw new Error(item?.error?.message ?? `Missing batch response for block ${chunk[i]}`);
          parsed.push({
            timestamp: Number(BigInt(item.result.timestamp)),
            traders: new Map(item.result.transactions.map((tx) => [tx.hash, tx.from] as const)),
          });
        }
        results[index] = parsed;
      }
    }));
    const result = new Map<bigint, BlockTradeData>();
    for (let index = 0; index < chunks.length; index++) {
      for (let item = 0; item < chunks[index].length; item++) result.set(chunks[index][item], results[index][item]);
    }
    return result;
  };
}
