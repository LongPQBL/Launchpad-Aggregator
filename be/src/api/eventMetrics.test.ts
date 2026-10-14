import { describe, expect, it } from 'vitest';
import { ApiEventBus } from './events.js';
import { createEventMetrics } from './eventMetrics.js';

describe('createEventMetrics', () => {
  it('counts events by type and measures how late the ones with a block time arrive', () => {
    let nowMs = 1_000_000_000_000;
    const bus = new ApiEventBus();
    const metrics = createEventMetrics(bus, () => nowMs);
    bus.publish({ type: 'trade.created', chainId: 1, tokenAddress: '0x1111111111111111111111111111111111111111', blockTimestamp: 1_000_000_000 - 4 });
    bus.publish({ type: 'trade.created', chainId: 1, tokenAddress: '0x1111111111111111111111111111111111111111', blockTimestamp: 1_000_000_000 - 40 });
    bus.publish({ type: 'trade.created', chainId: 1, tokenAddress: '0x1111111111111111111111111111111111111111', blockTimestamp: 1_000_000_000 - 10 });
    bus.publish({ type: 'launch.changed', chainId: 1 });
    nowMs += 5_000;
    const snapshot = metrics.snapshot();
    expect(snapshot.events['trade.created']).toMatchObject({ total: 3, lag: { samples: 3, p50Seconds: 10, p90Seconds: 40, maxSeconds: 40 } });
    expect(snapshot.events['launch.changed']).toMatchObject({ total: 1, lag: { samples: 0, p50Seconds: null } });
    expect(snapshot.events['pool.changed']).toMatchObject({ total: 0, lastAt: null });
  });

  it('treats a block time ahead of the clock as no delay, and keeps only the latest 200 samples', () => {
    const nowMs = 1_000_000_000_000;
    const bus = new ApiEventBus();
    const metrics = createEventMetrics(bus, () => nowMs);
    bus.publish({ type: 'pool.changed', chainId: 1, poolId: `0x${'ab'.repeat(32)}`, blockTimestamp: 1_000_000_000 + 30 });
    expect(metrics.snapshot().events['pool.changed']!.lag.maxSeconds).toBe(0);
    for (let i = 0; i < 250; i += 1) bus.publish({ type: 'pool.changed', chainId: 1, poolId: `0x${'ab'.repeat(32)}`, blockTimestamp: 1_000_000_000 - 7 });
    expect(metrics.snapshot().events['pool.changed']!.lag).toMatchObject({ samples: 200, p50Seconds: 7 });
  });
});
