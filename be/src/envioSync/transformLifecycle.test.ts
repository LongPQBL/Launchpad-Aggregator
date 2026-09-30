import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envioRawLifecycleToTransition, type EnvioRawLifecycleRow } from './transformLifecycle.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('envioRawLifecycleToTransition', () => {
  it('maps a swept row to phase 1', () => {
    const sweep = fixture.sweep as Record<string, unknown>;
    const row: EnvioRawLifecycleRow = {
      chainId: 4663, tokenAddress: fixture.tokenAddress as string, phase: 1, kind: 'swept',
      blockNumber: 27823772n, blockHash: sweep.blockHash as string,
      txHash: sweep.transactionHash as string, logIndex: 52,
    };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    expect(transition.phase).toBe(1);
    expect(transition.kind).toBe('swept');
    expect(transition.tokenAddress).toBe(fixture.tokenAddress as string);
    expect(transition.sourceId).toBe('pons-v2-lifecycle');
  });

  it('maps a graduated row to phase 2', () => {
    const graduation = fixture.graduation as Record<string, unknown>;
    const row: EnvioRawLifecycleRow = {
      chainId: 4663, tokenAddress: fixture.tokenAddress as string, phase: 2, kind: 'graduated',
      blockNumber: 27828161n, blockHash: graduation.blockHash as string,
      txHash: graduation.transactionHash as string, logIndex: 36,
    };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    expect(transition.phase).toBe(2);
    expect(transition.kind).toBe('graduated');
  });

  it('maps a rescued row to phase 3 (no fixture for this path — a synthetic but structurally valid row)', () => {
    const row: EnvioRawLifecycleRow = {
      chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', phase: 3, kind: 'rescued',
      blockNumber: 30_000_000n, blockHash: '0x' + 'e'.repeat(64),
      txHash: '0x' + '9'.repeat(64), logIndex: 1,
    };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    expect(transition.phase).toBe(3);
    expect(transition.kind).toBe('rescued');
  });
});
