import { parseAbi } from 'viem';

// Verified against two real on-chain transactions and one live eth_call simulation during
// docs/superpowers/specs/2026-10-06-launch-trading-design.md's research — not guessed.
// sell's returns(uint256) is assumed symmetric with buy, not independently simulated; callers
// must treat a decode failure on sell's result as "quote unavailable", not a crash.
export const curveTradeAbi = parseAbi([
  'function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
  'error CurveGraduated()',
  'error UnexpectedNativeValue()',
]);
