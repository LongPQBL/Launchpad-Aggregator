import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPonsFactorySources } from './sourceRegistry.js';

interface SourceFixture {
  sourceId: string;
  address: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  topics: string[];
  data: string;
  explorerUrl: string;
}

const fixtureUrl = new URL('../../../tests/fixtures/pons-launches.json', import.meta.url);

describe('pons factory registry', () => {
  it('includes both v1 factories and the v2 factory on Robinhood', () => {
    const sources = getPonsFactorySources();
    expect(sources.map((source) => [source.id, source.factory.toLowerCase(), source.startBlock])).toEqual([
      ['pons-v1-legacy', '0x0c37a24f5d23a486fa692d1500881d698b1f77a4', 8600612n],
      ['pons-v1-active', '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', 8991118n],
      ['pons-v2', '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', 26841846n],
    ]);
    expect(new Set(sources.map((source) => source.id)).size).toBe(3);
    expect(sources.every((source) => source.chainId === 4663 && source.startBlock > 0n)).toBe(true);
  });

  it('anchors each source to an actual on-chain launch log', () => {
    const fixtures = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as SourceFixture[];
    const sources = getPonsFactorySources();
    expect(fixtures).toHaveLength(3);
    for (const source of sources) {
      const sample = fixtures.find((fixture) => fixture.sourceId === source.id);
      expect(sample).toBeDefined();
      expect(sample!.blockNumber).toBeGreaterThanOrEqual(Number(source.startBlock));
      expect(sample!.address).toBe(source.factory.toLowerCase());
      expect(sample!.topics[0]).toBe(source.launchTopic);
      expect(sample!.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sample!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sample!.explorerUrl).toBe(`https://robinhoodchain.blockscout.com/tx/${sample!.txHash}`);
    }
  });
});
