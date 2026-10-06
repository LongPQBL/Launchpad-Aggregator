import { BaseError, ContractFunctionRevertedError } from 'viem';

// Only the two custom errors this app's own research has decoded and confirmed (see curveAbi.ts)
// get a tailored message. Anything else falls back to the raw revert/error name rather than
// inventing a guess at its meaning.
const KNOWN_ERRORS: Record<string, string> = {
  CurveGraduated: 'This token has already graduated off the bonding curve — trade it on its pool instead.',
  UnexpectedNativeValue: 'This trade does not accept native ETH — check the quote asset for this launch.',
};

export function decodeTradeError(error: unknown): string {
  if (error instanceof BaseError) {
    const revertError = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      const errorName = revertError.data?.errorName;
      // A standard Solidity `require(condition, "reason")` revert decodes with errorName
      // literally 'Error' (the canonical name for the built-in Error(string) selector) — the
      // actual human-readable reason lives on `.reason` instead, not in the known-custom-errors
      // map. Without this branch the fallback below would discard it and show the useless
      // literal string "Transaction would fail: Error".
      if (errorName === 'Error' && revertError.reason) {
        return `Transaction would fail: ${revertError.reason}`;
      }
      if (errorName) return KNOWN_ERRORS[errorName] ?? `Transaction would fail: ${errorName}`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
