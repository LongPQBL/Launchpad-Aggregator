import { describe, expect, it } from 'vitest';

describe('Pons V2 authoritative phase reconciliation', () => {
  it('verifies a projected phase only when the factory agrees at the requested safe block', async () => {
    const { reconcileV2Phase } = await import('./phaseReconcile.js');
    const result = await reconcileV2Phase('swept', 200n, async (block) => block === 200n ? 1 : 0);
    expect(result).toEqual({ status: 'verified', observedPhase: 1, blockNumber: 200n, reason: null });
  });

  it('marks a conflicting factory phase as a mismatch instead of silently overriding history', async () => {
    const { reconcileV2Phase } = await import('./phaseReconcile.js');
    const result = await reconcileV2Phase('graduated', 200n, async () => 1);
    expect(result).toEqual({ status: 'mismatch', observedPhase: 1, blockNumber: 200n,
      reason: 'Factory phase swept differs from indexed graduated' });
  });

  it('marks unavailable historical state incomplete without claiming phase zero', async () => {
    const { reconcileV2Phase } = await import('./phaseReconcile.js');
    const result = await reconcileV2Phase('trading', 200n, async () => { throw new Error('archive required'); });
    expect(result).toEqual({ status: 'incomplete', observedPhase: null, blockNumber: 200n, reason: 'archive required' });
  });
});
