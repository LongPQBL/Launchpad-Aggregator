import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePoolFee } from './use-pool-fee';

const hooks = vi.hoisted(() => ({
  feeData: undefined as number | undefined,
  isLoading: false,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useReadContract: () => ({ data: hooks.feeData, isLoading: hooks.isLoading }),
}));

const pool = '0x4444444444444444444444444444444444444444' as const;

beforeEach(() => {
  hooks.feeData = undefined;
  hooks.isLoading = false;
});

describe('usePoolFee', () => {
  it('reports the real fee once resolved', () => {
    hooks.feeData = 10000;
    const { result } = renderHook(() => usePoolFee(pool));
    expect(result.current.fee).toBe(10000);
  });

  it('reports null, never a guessed fee, while unresolved', () => {
    hooks.feeData = undefined;
    hooks.isLoading = true;
    const { result } = renderHook(() => usePoolFee(pool));
    expect(result.current.fee).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
