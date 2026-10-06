import { BaseError, ContractFunctionRevertedError } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeTradeError } from './decodeTradeError';

function revertError(errorName: string) {
  const inner = new ContractFunctionRevertedError({
    abi: [{ type: 'error', name: errorName, inputs: [] }],
    data: undefined,
    functionName: 'buy',
  });
  // ContractFunctionRevertedError only infers data.errorName when it can decode raw revert data;
  // for a test we set it directly since we're exercising decodeTradeError, not viem's own decoder.
  Object.defineProperty(inner, 'data', { value: { errorName, args: [] } });
  return new BaseError('execution reverted', { cause: inner });
}

describe('decodeTradeError', () => {
  it('maps CurveGraduated to a plain-language message', () => {
    expect(decodeTradeError(revertError('CurveGraduated'))).toBe(
      'This token has already graduated off the bonding curve — trade it on its pool instead.',
    );
  });

  it('maps UnexpectedNativeValue to a plain-language message', () => {
    expect(decodeTradeError(revertError('UnexpectedNativeValue'))).toBe(
      'This trade does not accept native ETH — check the quote asset for this launch.',
    );
  });

  it('falls back to the revert name for an unrecognized custom error', () => {
    expect(decodeTradeError(revertError('SlippageExceeded'))).toBe('Transaction would fail: SlippageExceeded');
  });

  it('falls back to a plain Error message for a non-viem error', () => {
    expect(decodeTradeError(new Error('network request failed'))).toBe('network request failed');
  });

  it('falls back to a generic message for a non-Error value', () => {
    expect(decodeTradeError('not an error')).toBe('Unknown error');
  });
});
