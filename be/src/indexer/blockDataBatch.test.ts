import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { createBatchedGetBlockData } from './blockDataBatch.js';

const rpcUrl = 'https://example-rpc.test';
const trader = '0x1234567890123456789012345678901234567890' as Address;

function rawBlock(blockNumber: bigint, txHash: Hash, timestamp = 1_700_000_000) {
  return {
    timestamp: `0x${timestamp.toString(16)}`,
    transactions: [{ hash: txHash, from: trader }],
  };
}

describe('createBatchedGetBlockData', () => {
  it('sends one JSON-RPC batch request for all requested blocks and parses timestamp/traders', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const requests = JSON.parse(init.body) as Array<{ id: number; params: [string, boolean] }>;
      const responses = requests.map((req) => ({
        jsonrpc: '2.0', id: req.id,
        result: rawBlock(BigInt(req.params[0]), `0x${req.id.toString().repeat(64)}`.slice(0, 66) as Hash),
      }));
      return { json: async () => responses } as Response;
    };
    const getBlocksData = createBatchedGetBlockData(rpcUrl, 100, fetchImpl as typeof fetch);
    const result = await getBlocksData([100n, 200n, 300n]);
    expect(calls).toHaveLength(1);
    expect((calls[0].body as unknown[]).length).toBe(3);
    expect(result.get(100n)?.timestamp).toBe(1_700_000_000);
    expect(result.get(200n)?.traders.size).toBe(1);
    expect(result.size).toBe(3);
  });

  it('splits into multiple batch requests when block count exceeds batchSize', async () => {
    const calls: unknown[][] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const requests = JSON.parse(init.body) as Array<{ id: number; params: [string, boolean] }>;
      calls.push(requests);
      const responses = requests.map((req) => ({
        jsonrpc: '2.0', id: req.id,
        result: rawBlock(BigInt(req.params[0]), `0x${req.id.toString().repeat(64)}`.slice(0, 66) as Hash),
      }));
      return { json: async () => responses } as Response;
    };
    const getBlocksData = createBatchedGetBlockData(rpcUrl, 2, fetchImpl as typeof fetch);
    const result = await getBlocksData([1n, 2n, 3n]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(2);
    expect(calls[1]).toHaveLength(1);
    expect(result.size).toBe(3);
  });

  it('throws the RPC-reported message when the whole batch is rejected (non-array response)', async () => {
    const fetchImpl = async () => ({
      json: async () => ({ jsonrpc: '2.0', error: { code: 429, message: 'Too Many Requests' } }),
    } as Response);
    const getBlocksData = createBatchedGetBlockData(rpcUrl, 100, fetchImpl as typeof fetch);
    await expect(getBlocksData([1n])).rejects.toThrow('Too Many Requests');
  });

  it('throws when an individual item in the batch has its own error', async () => {
    const fetchImpl = async () => ({
      json: async () => [{ jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'block not found' } }],
    } as Response);
    const getBlocksData = createBatchedGetBlockData(rpcUrl, 100, fetchImpl as typeof fetch);
    await expect(getBlocksData([1n])).rejects.toThrow('block not found');
  });
});
