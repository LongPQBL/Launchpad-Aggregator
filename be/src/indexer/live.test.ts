import { describe, expect, it } from 'vitest';
import { startLiveIndexer, type LiveDeps } from './live.js';

describe('live indexer', () => {
  it('uses HTTP polling to repair a 101–110 gap after WSS disconnects', async () => {
    let httpHead = 100n;
    let cursor = 99n;
    const ranges: Array<[bigint, bigint]> = [];
    let poll: (() => Promise<void>) | undefined;
    let wake: (() => Promise<void>) | undefined;
    const deps: LiveDeps = {
      confirmationDepth: 0n,
      pollIntervalMs: 1_000,
      getHttpHead: async () => httpHead,
      scanToSafeHead: async (head) => { if (head > cursor) { ranges.push([cursor + 1n, head]); cursor = head; } },
      schedulePoll: (callback) => { poll = callback; return () => { poll = undefined; }; },
      watchHeads: (callback) => { wake = callback; return () => { wake = undefined; }; },
    };
    const stop = await startLiveIndexer(deps);
    expect(ranges).toEqual([[100n, 100n]]);
    httpHead = 110n;
    await poll!();
    expect(ranges).toEqual([[100n, 100n], [101n, 110n]]);
    await wake!();
    expect(ranges).toHaveLength(2);
    stop();
    expect(poll).toBeUndefined();
    expect(wake).toBeUndefined();
  });

  it('keeps polling when WSS is unavailable and respects confirmation depth', async () => {
    let head = 100n;
    let poll: (() => Promise<void>) | undefined;
    const scanned: bigint[] = [];
    const stop = await startLiveIndexer({
      confirmationDepth: 2n,
      pollIntervalMs: 1_000,
      getHttpHead: async () => head,
      scanToSafeHead: async (safeHead) => { scanned.push(safeHead); },
      schedulePoll: (callback) => { poll = callback; return () => {}; },
      watchHeads: () => { throw new Error('WebSocket unavailable'); },
    });
    head = 105n;
    await poll!();
    expect(scanned).toEqual([98n, 103n]);
    stop();
  });

  it('checks for reorgs on repeated heads and records a safe head only after a scan', async () => {
    let wake: (() => Promise<void>) | undefined;
    const checked: bigint[] = [];
    const scanned: bigint[] = [];
    const recorded: bigint[] = [];
    const stop = await startLiveIndexer({
      confirmationDepth: 0n,
      pollIntervalMs: 1_000,
      getHttpHead: async () => 100n,
      reconcileHead: async (head) => { checked.push(head); },
      scanToSafeHead: async (head) => { scanned.push(head); },
      recordSafeHead: async (head) => { recorded.push(head); },
      schedulePoll: () => () => {},
      watchHeads: (callback) => { wake = callback; return () => {}; },
    });
    await wake!();
    expect(checked).toEqual([100n, 100n]);
    expect(scanned).toEqual([100n]);
    expect(recorded).toEqual([100n]);
    stop();
  });
});
