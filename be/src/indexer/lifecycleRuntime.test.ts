import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hash, type Log } from 'viem';
import type { RpcLog } from '../launchpads/pons/v1/adapter.js';
import type { Launch, Venue } from '../domain/types.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const token = fixture.tokenAddress as Address;
const graduation = fixture.graduation as Record<string, unknown>;
const initialize = fixture.initialize as Record<string, unknown>;

function asLog(raw: Record<string, unknown>): RpcLog {
  return { address: raw.address as Address, topics: raw.topics as Hash[], data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number), blockHash: raw.blockHash as Hash,
    transactionHash: raw.transactionHash as Hash, logIndex: Number(raw.logIndex) };
}

const launch: Launch = { chainId: 4663, tokenAddress: token, name: 'Sample', symbol: 'SAMPLE', tokenDecimals: 18,
  platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: 'launch-log',
  factoryAddress: graduation.address as Address, deployerAddress: '0x0000000000000000000000000000000000000001',
  launchBlock: 27_000_000n, launchTxHash: `0x${'1'.repeat(64)}`, quoteAsset: {
    address: fixture.quoteAddress as Address, symbol: 'NVDA', decimals: 18 }, lifecycleStatus: 'trading',
  v4PoolFee: 0, v4TickSpacing: 200 };
const curve: Venue = { id: `4663:curve:${fixture.curveAddress}`, chainId: 4663, tokenAddress: token, kind: 'curve',
  ref: fixture.curveAddress as string, sourceId: 'pons-v2', sourceLogId: 'launch-log',
  effectiveFromBlock: launch.launchBlock, effectiveToBlock: null, official: true };

describe('Pons V2 lifecycle runtime', () => {
  it('scans the factory from deployment and opens only the matching initialized V4 pool', async () => {
    const { getV2LifecycleSource, createLifecycleDecoder } = await import('./lifecycleRuntime.js');
    const source = getV2LifecycleSource();
    expect(source.id).toBe('pons-v2-lifecycle');
    expect(source.startBlock).toBe(26841846n);
    expect(source.addresses.map((address) => address.toLowerCase())).toEqual([graduation.address]);
    const decoder = createLifecycleDecoder({ loadLaunch: async () => ({ launch, venue: curve }),
      getReceiptLogs: async () => [asLog(initialize)],
      poolManager: fixture.poolManagerAddress as Address, hook: fixture.hookAddress as Address });
    const batch = await decoder([asLog(graduation) as Log], source);
    expect(batch.transitions).toMatchObject([{ phase: 2, tokenAddress: token, kind: 'graduated', logIndex: 36 }]);
    expect(batch.venues).toMatchObject([{ kind: 'v4_pool', ref: fixture.poolId, sourceId: 'pons-v2-lifecycle',
      effectiveFromBlock: 27828161n, effectiveFromLogIndex: 16, sourceLogId: expect.any(String) }]);
    expect(batch.rawLogs.map((log) => log.logIndex)).toEqual([16, 36]);
    expect(batch.trades).toEqual([]);
  });

  it('records sweep once and does not open a pool from its companion force-sweep notice', async () => {
    const { getV2LifecycleSource, createLifecycleDecoder } = await import('./lifecycleRuntime.js');
    const sweep = parseAbiItem('event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)');
    const force = parseAbiItem('event LaunchForceSwept(address indexed token)');
    const sweepLog = { ...asLog(graduation), logIndex: 3,
      topics: encodeEventTopics({ abi: [sweep], args: { token } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [9n, 4n]) } as RpcLog;
    const forceLog = { ...sweepLog, logIndex: 4,
      topics: encodeEventTopics({ abi: [force], args: { token } }), data: '0x' } as RpcLog;
    const decoder = createLifecycleDecoder({ loadLaunch: async () => ({ launch, venue: curve }),
      getReceiptLogs: async () => { throw new Error('No receipt needed for sweep'); },
      poolManager: fixture.poolManagerAddress as Address, hook: fixture.hookAddress as Address });
    const batch = await decoder([sweepLog as Log, forceLog as Log], getV2LifecycleSource());
    expect(batch.transitions).toMatchObject([{ phase: 1, kind: 'swept', logIndex: 3 }]);
    expect(batch.venues).toEqual([]);
  });

  it('rejects an unknown launch or a mismatched Initialize receipt', async () => {
    const { getV2LifecycleSource, createLifecycleDecoder } = await import('./lifecycleRuntime.js');
    const source = getV2LifecycleSource();
    const missing = createLifecycleDecoder({ loadLaunch: async () => null,
      getReceiptLogs: async () => [asLog(initialize)],
      poolManager: fixture.poolManagerAddress as Address, hook: fixture.hookAddress as Address });
    await expect(missing([asLog(graduation) as Log], source)).rejects.toThrow(/unknown launch/i);
    for (const wrong of [
      { ...asLog(initialize), transactionHash: `0x${'2'.repeat(64)}` as Hash },
      { ...asLog(initialize), address: token },
    ]) {
      const decoder = createLifecycleDecoder({ loadLaunch: async () => ({ launch, venue: curve }),
        getReceiptLogs: async () => [wrong],
        poolManager: fixture.poolManagerAddress as Address, hook: fixture.hookAddress as Address });
      await expect(decoder([asLog(graduation) as Log], source)).rejects.toThrow(/initialize/i);
    }
  });

  it('caps lifecycle scanning at the launch cursor and validates factory pool dependencies', async () => {
    const { lifecycleTarget, readV2FactoryPoolConfig } = await import('./lifecycleRuntime.js');
    expect(lifecycleTarget(100n, 110n)).toBe(100n);
    expect(lifecycleTarget(120n, 110n)).toBe(110n);
    const correct = { readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'poolManager' ? fixture.poolManagerAddress : fixture.hookAddress };
    expect(await readV2FactoryPoolConfig(correct)).toEqual({
      poolManager: fixture.poolManagerAddress, hook: fixture.hookAddress,
    });
    const wrong = { readContract: async () => token };
    await expect(readV2FactoryPoolConfig(wrong)).rejects.toThrow(/factory.*pool/i);
  });
});
