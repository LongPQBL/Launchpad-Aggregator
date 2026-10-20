import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { COMMAND_V2_SWAP_EXACT_IN, encodeV2SwapInput } from './v2SwapEncoding';

const a = '0x1111111111111111111111111111111111111111' as const;
const b = '0x2222222222222222222222222222222222222222' as const;
const me = '0x0000000000000000000000000000000000000001' as const;

describe('encodeV2SwapInput', () => {
  it('uses the V2_SWAP_EXACT_IN command id', () => {
    expect(COMMAND_V2_SWAP_EXACT_IN).toBe(0x08);
  });

  it('round-trips the six fields Universal Router 2.1 decodes, with a two-token path and no hop price limit', () => {
    const encoded = encodeV2SwapInput({ tokenIn: a, tokenOut: b, amountIn: 1000n, amountOutMinimum: 900n, payerIsUser: true, recipient: me });
    const [recipient, amountIn, amountOutMin, path, payerIsUser, limits] = decodeAbiParameters(
      parseAbiParameters('address, uint256, uint256, address[], bool, uint256[]'), encoded);
    expect([recipient, amountIn, amountOutMin, [...path], payerIsUser, [...limits]]).toEqual([me, 1000n, 900n, [a, b], true, []]);
  });
});
