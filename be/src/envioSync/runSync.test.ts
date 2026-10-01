import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { readV1TokenMetadata } from '../launchpads/pons/v1/state.js';

describe('V1 RPC metadata contract', () => {
  it('reads name, symbol, decimals and liquidity pool from the token', async () => {
    const token = '0x2222222222222222222222222222222222222222' as Address;
    const functions: string[] = [];
    const client = { readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      expect(address).toBe(token);
      functions.push(functionName);
      if (functionName === 'name') return 'Test Token';
      if (functionName === 'symbol') return 'TEST';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return '0x1111111111111111111111111111111111111111';
      throw new Error(`unexpected ${functionName}`);
    } };
    expect(await readV1TokenMetadata(client, token)).toEqual({
      name: 'Test Token', symbol: 'TEST', decimals: 18, liquidityPool: '0x1111111111111111111111111111111111111111',
    });
    expect(functions).toEqual(['name', 'symbol', 'decimals', 'liquidityPool']);
  });
});
