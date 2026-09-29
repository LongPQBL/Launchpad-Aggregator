import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Log } from 'viem';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { getFactoryLogSources } from '../cli/indexer.js';
import { createFactoryDecoder } from './factoryRuntime.js';

interface Fixture { sourceId: string; address: string; blockNumber: number; blockHash: string; txHash: string; logIndex: number; topics: string[]; data: string }
const fixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-launches.json', import.meta.url), 'utf8')) as Fixture[];

describe('factory runtime decoder', () => {
  it('turns a real v2 launch log into a persisted launch, venue and raw log', async () => {
    const factory = getPonsFactorySources().find((source) => source.id === 'pons-v2')!;
    const log = fixtures.find((item) => item.sourceId === factory.id)!;
    const decoder = createFactoryDecoder({
      loadV1: async () => { throw new Error('wrong version'); },
      loadV2: async (event) => ({
        record: { token: event.tokenAddress, curve: event.curveAddress, deployer: event.deployerAddress,
          pairToken: event.pairToken, poolFee: 0, tickSpacing: 60, phase: 0 as const, exists: true },
        metadata: { name: 'Fixture', symbol: 'FIX', decimals: 18 },
        quoteAsset: { address: event.pairToken, symbol: 'NVDA', decimals: 18 },
      }),
    });
    const batch = await decoder([{
      address: log.address, blockNumber: BigInt(log.blockNumber), blockHash: log.blockHash,
      transactionHash: log.txHash, logIndex: log.logIndex, topics: log.topics, data: log.data,
    } as Log], getFactoryLogSources().find((source) => source.id === factory.id)!);
    expect(batch.launches).toHaveLength(1);
    expect(batch.launches[0].sourceId).toBe('pons-v2');
    expect(batch.venues[0].kind).toBe('curve');
    expect(batch.rawLogs).toHaveLength(1);
  });
});
