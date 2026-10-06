import { parseAbi } from 'viem';

// Verified against two real on-chain transactions and one live eth_call simulation during
// docs/superpowers/specs/2026-10-06-launch-trading-design.md's research — not guessed.
// sell's returns(uint256) was independently confirmed on 2026-10-07 via three live eth_call
// simulations against a real current holder (0xbb221ec4...5da31's curve, tokensIn 500k/1M/2M)
// on the public Robinhood RPC: each call decoded cleanly as a single uint256 and scaled
// sensibly with trade size (826,640,967,977,201 / 1,652,447,787,651,704 / 3,301,564,027,344,448
// wei of native quote), consistent with a genuine bonding-curve payout rather than a decode
// fluke. Callers must still treat a decode failure on sell's result as "quote unavailable", not
// a crash — this confirms the happy path, not every revert path.
export const curveTradeAbi = parseAbi([
  'function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
  'error CurveGraduated()',
  'error UnexpectedNativeValue()',
]);
