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

// A standard Solidity `require(condition, "reason")` revert decodes with errorName literally
// 'Error' (the canonical name for the built-in Error(string) selector) and the human-readable
// text on `.reason` instead of `.data.errorName` — simulate that shape directly, same technique
// as revertError() above.
function revertErrorWithReason(reason: string) {
  const inner = new ContractFunctionRevertedError({
    abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }],
    data: undefined,
    functionName: 'buy',
  });
  Object.defineProperty(inner, 'data', { value: { errorName: 'Error', args: [reason] } });
  Object.defineProperty(inner, 'reason', { value: reason });
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

  it('surfaces the real string reason for a standard Error(string) revert, instead of the literal useless "Error"', () => {
    const message = decodeTradeError(revertErrorWithReason('STF'));
    expect(message).not.toBe('Transaction would fail: Error');
    expect(message).toContain('STF');
  });

  it('falls back to a plain Error message for a non-viem error', () => {
    expect(decodeTradeError(new Error('network request failed'))).toBe('network request failed');
  });

  it('falls back to a generic message for a non-Error value', () => {
    expect(decodeTradeError('not an error')).toBe('Unknown error');
  });
});
