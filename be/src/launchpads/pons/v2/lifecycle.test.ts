import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hash } from 'viem';
import { getPonsFactorySources } from '../sourceRegistry.js';
import type { RpcLog } from '../v1/adapter.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const factory = getPonsFactorySources()[2];
const token = fixture.tokenAddress as Address;
const graduation = fixture.graduation as Record<string, unknown>;

function asLog(raw: Record<string, unknown>): RpcLog {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number),
    blockHash: raw.blockHash as Hash,
    transactionHash: raw.transactionHash as Hash,
    logIndex: Number(raw.logIndex),
  };
}

const base = asLog(graduation);

describe('Pons V2 lifecycle evidence', () => {
  it('decodes a real PoolGraduated log as phase 2 with exact provenance', async () => {
    const { decodeV2LifecycleLog } = await import('./lifecycle.js');
    const result = decodeV2LifecycleLog(base, factory);
    expect(result).toMatchObject({ tokenAddress: token, phase: 2, kind: 'graduated',
      blockNumber: 27828161n, blockHash: base.blockHash, txHash: base.transactionHash, logIndex: 36 });
    expect(result?.sourceLogId).toContain('4663');
  });

  it('decodes sweep as phase 1 and rescue as phase 3', async () => {
    const { decodeV2LifecycleLog } = await import('./lifecycle.js');
    const sweep = parseAbiItem('event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)');
    const rescue = parseAbiItem('event LaunchGraduationRescued(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount)');
    const recipient = '0x0000000000000000000000000000000000000002' as Address;
    const sweepLog = { ...base, topics: encodeEventTopics({ abi: [sweep], args: { token } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [9n, 4n]) } as RpcLog;
    const rescueLog = { ...base, topics: encodeEventTopics({ abi: [rescue], args: { token, recipient } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [9n, 4n]) } as RpcLog;
    expect(decodeV2LifecycleLog(sweepLog, factory)?.phase).toBe(1);
    expect(decodeV2LifecycleLog(rescueLog, factory)?.phase).toBe(3);
  });

  it('does not count LaunchForceSwept as a second transition', async () => {
    const { decodeV2LifecycleLog } = await import('./lifecycle.js');
    const event = parseAbiItem('event LaunchForceSwept(address indexed token)');
    const log = { ...base, topics: encodeEventTopics({ abi: [event], args: { token } }), data: '0x' } as RpcLog;
    expect(decodeV2LifecycleLog(log, factory)).toBeNull();
  });

  it('rejects copied factory addresses and malformed lifecycle logs', async () => {
    const { decodeV2LifecycleLog } = await import('./lifecycle.js');
    expect(() => decodeV2LifecycleLog({ ...base, address: token }, factory)).toThrow(/factory/i);
    expect(() => decodeV2LifecycleLog({ ...base, data: '0x' }, factory)).toThrow();
  });
});
