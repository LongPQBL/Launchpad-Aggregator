import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Real, standard Uniswap QuoterV2 — independently verified on Robinhood Chain with two live
// eth_calls against the project's own fixture pool (be/tests/fixtures/pons-v1-reference.json's
// 0x10cc6bd38112cac182db90b6a71d8bb5939526ba): both directions' amountOut and gasEstimate
// matched exactly across two separate calls. See
// docs/superpowers/specs/2026-10-07-v3-pool-swap-permit2-migration-design.md's "The blocker
// this spec resolves, and how" section for the full numbers. Unlike V4_QUOTER_ADDRESS
// (v4QuoterAbi.ts), this is a genuine QuoterV2 with real V3 support — confirmed only after three
// different V3-shaped signatures failed against V4_QUOTER_ADDRESS itself.
export const V3_QUOTER_ADDRESS: Address = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';

export const v3QuoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
