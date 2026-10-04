import type { Address, Hash } from 'viem';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';

export interface LaunchLogFilter { address: Address; topic: Hash; fromBlock: bigint; toBlock: bigint }
export interface LaunchLog {
  address: string; topics: readonly string[]; blockNumber: bigint; blockHash: string;
  transactionHash: string; logIndex: number;
}
export interface LaunchLogClient { getLogs(filter: LaunchLogFilter): Promise<readonly LaunchLog[]> }
export interface LaunchEventKey {
  chainId: number; factoryAddress: string; txHash: string; logIndex: number;
  blockNumber: bigint; blockHash: string;
}

export interface AuditRangeArgs {
  sourceId: string; fromBlock: bigint; toBlock: bigint; finalizedFence: bigint; maxRange: bigint;
}

export function parseAuditRangeArgs(args: readonly string[]): AuditRangeArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Invalid audit flag');
    values.set(args[i]!.slice(2), args[i + 1]!);
  }
  const sourceId = values.get('source');
  const decimal = (name: string, fallback?: string): bigint => {
    const value = values.get(name) ?? fallback;
    if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid --${name}`);
    return BigInt(value);
  };
  if (!sourceId) throw new Error('Missing --source');
  const fromBlock = decimal('from');
  const toBlock = decimal('to');
  const finalizedFence = decimal('fence');
  const maxRange = decimal('max-range', '2000');
  if (toBlock > finalizedFence) throw new Error('Range exceeds finalized fence');
  if (toBlock < fromBlock || maxRange < 1n || maxRange > 2000n) throw new Error('Invalid bounded audit range');
  if (toBlock - fromBlock + 1n > 20_000n) throw new Error('Audit command is limited to 20,000 blocks');
  return { sourceId, fromBlock, toBlock, finalizedFence, maxRange };
}

export function validateAuditFence(toBlock: bigint, fence: bigint, observedHead: bigint): void {
  if (fence > observedHead) throw new Error('Audit fence exceeds observed head');
  if (toBlock > fence - 500n) throw new Error('Audit range includes provisional blocks');
}

export async function readLaunchEvidence(
  client: LaunchLogClient, source: FactorySource, fromBlock: bigint, toBlock: bigint, maxRange: bigint,
  options: { finalizedFence?: bigint; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LaunchEventKey[]> {
  if (fromBlock < source.startBlock) throw new Error('Range begins before source start');
  if (toBlock > (options.finalizedFence ?? toBlock)) throw new Error('Range exceeds finalized fence');
  if (toBlock < fromBlock || maxRange < 1n || maxRange > 2000n) throw new Error('Invalid bounded launch range');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const events: LaunchEventKey[] = [];
  const seen = new Set<string>();
  for (let start = fromBlock; start <= toBlock; start += maxRange) {
    const end = start + maxRange - 1n < toBlock ? start + maxRange - 1n : toBlock;
    let rows: readonly LaunchLog[] | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        rows = await client.getLogs({ address: source.factory, topic: source.launchTopic, fromBlock: start, toBlock: end });
        break;
      } catch (error) {
        if (!/429|rate.limit|too.many.requests/i.test(String(error)) || attempt === 3) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
    for (const row of rows ?? []) {
      if (row.address.toLowerCase() !== source.factory.toLowerCase()
        || row.topics[0]?.toLowerCase() !== source.launchTopic.toLowerCase()
        || row.blockNumber < start || row.blockNumber > end) continue;
      const item: LaunchEventKey = {
        chainId: source.chainId, factoryAddress: source.factory.toLowerCase(),
        txHash: row.transactionHash.toLowerCase(), logIndex: row.logIndex,
        blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase(),
      };
      const key = `${item.txHash}:${item.logIndex}:${item.blockHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(item);
    }
  }
  return events.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1
    : a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash));
}
