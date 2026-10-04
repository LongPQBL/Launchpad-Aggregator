import { decodeEventLog, parseAbi, parseAbiItem, type Address } from 'viem';
import type { Pool } from 'pg';
import { upsertPriceRounds } from './priceRounds.js';

export interface BackfillRpcClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getLogs(parameters: { address: Address; fromBlock: bigint; toBlock: bigint; topics: readonly [`0x${string}`] }): Promise<readonly {
    blockNumber: bigint; logIndex: number; data: `0x${string}`; topics: readonly `0x${string}`[];
  }[]>;
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

const answerUpdatedEvent = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)');
const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);

// Binary-searches block numbers for the two unix-second range bounds (viem has no "block at
// timestamp" RPC call; Chainlink chains don't guarantee one either) — bounded to O(log head) calls.
async function blockAtOrAfter(client: BackfillRpcClient, targetSeconds: number, head: bigint): Promise<bigint> {
  let low = 0n;
  let high = head;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < targetSeconds) low = mid + 1n; else high = mid;
  }
  return low;
}

export async function backfillRoundsForFeed(
  client: BackfillRpcClient, pool: Pool, chainId: number, aggregatorAddress: Address, rangeStart: number, rangeEnd: number,
): Promise<number> {
  const head = await client.getBlockNumber();
  const fromBlock = await blockAtOrAfter(client, rangeStart, head);
  const toBlock = rangeEnd >= Math.floor(Date.now() / 1000) ? head : await blockAtOrAfter(client, rangeEnd, head);
  const [logs, decimalsResult] = await Promise.all([
    client.getLogs({ address: aggregatorAddress, fromBlock, toBlock, topics: [answerUpdatedEvent as unknown as `0x${string}`] }),
    client.readContract({ address: aggregatorAddress, abi: decimalsAbi, functionName: 'decimals' }),
  ]);
  if (typeof decimalsResult !== 'number' || !Number.isInteger(decimalsResult) || decimalsResult < 0 || decimalsResult > 255) {
    throw new Error(`Invalid decimals() for aggregator ${aggregatorAddress}`);
  }
  const rounds = logs.map((log) => {
    const decoded = decodeEventLog({ abi: [answerUpdatedEvent], data: log.data, topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]], strict: true });
    if (decoded.args.current <= 0n) throw new Error(`Invalid (non-positive) Chainlink answer for aggregator ${aggregatorAddress}`);
    return {
      roundId: decoded.args.roundId, answerRaw: decoded.args.current, decimals: decimalsResult,
      startedAt: Number(decoded.args.updatedAt), updatedAt: Number(decoded.args.updatedAt),
      blockNumber: log.blockNumber, logIndex: log.logIndex,
    };
  });
  return upsertPriceRounds(pool, chainId, aggregatorAddress, rounds);
}
