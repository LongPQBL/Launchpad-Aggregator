import { describe, expect, it } from 'vitest';
import { estimateBackfill } from './backfillEstimate.js';

function sample(sourceId: string, fromBlock: bigint, toBlock: bigint, elapsedSeconds: number, rpc429Count = 0) {
  return { sourceId, windowStartBlock: fromBlock, windowEndBlock: toBlock, elapsedSeconds, rpc429Count };
}

describe('estimateBackfill', () => {
  it('uses critical-path time (max), not a sum, for independent sources', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [
        { sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n },
        { sourceId: 'b', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n },
      ],
      samples: [
        sample('a', 0n, 100n, 100), // 1 block/s, 1000 remaining -> 1000s
        sample('b', 0n, 500n, 100), // 5 blocks/s, 1000 remaining -> 200s
      ],
      unresolvedPoolDiscovery: false,
    });
    expect(result.pipeline.reliable).toBe(true);
    if (result.pipeline.reliable) {
      // Independent sources run in parallel: pipeline time is max(1000, 200) = 1000, not 1000+200.
      expect(result.pipeline.etaSecondsLow).toBe(1_000);
      expect(result.pipeline.etaSecondsHigh).toBe(1_000);
    }
  });

  it('adds a dependent stage\'s own time on top of its upstream dependency\'s finish time', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [
        { sourceId: 'factory', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n },
        { sourceId: 'trade', dependsOn: ['factory'], certifiedFrontier: 0n, startBlock: 0n },
      ],
      samples: [
        sample('factory', 0n, 200n, 100), // 2 blocks/s, 1000 remaining -> 500s
        sample('trade', 0n, 100n, 100), // 1 block/s, 1000 remaining -> 1000s
      ],
      unresolvedPoolDiscovery: false,
    });
    expect(result.pipeline.reliable).toBe(true);
    if (result.pipeline.reliable) {
      // trade cannot finish before factory (its dependency) finishes: 500 + 1000 = 1500, not max(500,1000)=1000.
      expect(result.pipeline.etaSecondsLow).toBe(1_500);
      expect(result.pipeline.etaSecondsHigh).toBe(1_500);
    }
  });

  it('reports a completed source as zero remaining and excludes it from the critical path', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [
        { sourceId: 'done', dependsOn: [], certifiedFrontier: 1_000n, startBlock: 0n },
      ],
      samples: [],
      unresolvedPoolDiscovery: false,
    });
    expect(result.perSource[0]).toMatchObject({ sourceId: 'done', remainingBlocks: 0n });
    expect(result.pipeline.reliable).toBe(true);
    if (result.pipeline.reliable) {
      expect(result.pipeline.etaSecondsLow).toBe(0);
      expect(result.pipeline.etaSecondsHigh).toBe(0);
    }
  });

  it('is unreliable when a source with remaining work has no throughput sample', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [],
      unresolvedPoolDiscovery: false,
    });
    expect(result.pipeline).toMatchObject({ reliable: false });
  });

  it('is unreliable when the observed sample window is too short to trust', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [sample('a', 0n, 10n, 2)], // 2 seconds of observed work: far too short to extrapolate
      unresolvedPoolDiscovery: false,
    });
    expect(result.pipeline).toMatchObject({ reliable: false, reason: expect.stringMatching(/sample|short/i) });
  });

  it('is unreliable when a source has repeated 429s', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [sample('a', 0n, 100n, 100, 5)],
      unresolvedPoolDiscovery: false,
    });
    expect(result.pipeline).toMatchObject({ reliable: false, reason: expect.stringMatching(/429|rate limit/i) });
  });

  it('is unreliable when V4 pool discovery is not yet complete, even with clean throughput samples', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [sample('a', 0n, 1_000n, 1_000)],
      unresolvedPoolDiscovery: true,
    });
    expect(result.pipeline).toMatchObject({ reliable: false, reason: expect.stringMatching(/v4|pool/i) });
  });

  it('always calls out that the safe head keeps advancing during backfill', () => {
    const reliable = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [sample('a', 0n, 1_000n, 1_000)],
      unresolvedPoolDiscovery: false,
    });
    expect(reliable.pipeline.caveats.some((caveat) => /safe head/i.test(caveat))).toBe(true);
    const unreliable = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [],
      unresolvedPoolDiscovery: false,
    });
    expect(unreliable.pipeline.caveats.some((caveat) => /safe head/i.test(caveat))).toBe(true);
  });

  it('gives a wider range when observed throughput varies across samples', () => {
    const result = estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: [], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [
        sample('a', 0n, 100n, 100), // 1 block/s
        sample('a', 0n, 400n, 100), // 4 blocks/s
      ],
      unresolvedPoolDiscovery: false,
    });
    expect(result.pipeline.reliable).toBe(true);
    if (result.pipeline.reliable) {
      // fastest observed rate (4 b/s) gives the low bound, slowest (1 b/s) gives the high bound.
      expect(result.pipeline.etaSecondsLow).toBe(250); // 1000 / 4
      expect(result.pipeline.etaSecondsHigh).toBe(1_000); // 1000 / 1
    }
  });

  it('rejects an invalid dependency reference', () => {
    expect(() => estimateBackfill({
      safeHead: 1_000n,
      sources: [{ sourceId: 'a', dependsOn: ['missing'], certifiedFrontier: 0n, startBlock: 0n }],
      samples: [],
      unresolvedPoolDiscovery: false,
    })).toThrow(/unknown/i);
  });
});
