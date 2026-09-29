import type { LifecycleStatus } from '../domain/types.js';
import { phaseToLifecycle } from '../launchpads/pons/v2/adapter.js';

export interface PhaseReconciliation {
  status: 'verified' | 'mismatch' | 'incomplete';
  observedPhase: 0 | 1 | 2 | 3 | null;
  blockNumber: bigint;
  reason: string | null;
}

export async function reconcileV2Phase(projected: LifecycleStatus, blockNumber: bigint,
  readPhase: (blockNumber: bigint) => Promise<0 | 1 | 2 | 3>): Promise<PhaseReconciliation> {
  try {
    const observedPhase = await readPhase(blockNumber);
    const observed = phaseToLifecycle(observedPhase);
    return observed === projected
      ? { status: 'verified', observedPhase, blockNumber, reason: null }
      : { status: 'mismatch', observedPhase, blockNumber,
        reason: `Factory phase ${observed} differs from indexed ${projected}` };
  } catch (error) {
    return { status: 'incomplete', observedPhase: null, blockNumber,
      reason: error instanceof Error ? error.message : String(error) };
  }
}
