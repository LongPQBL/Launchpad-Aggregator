import { parseAbi } from 'viem';
import type { Address } from 'viem';

// The V4 Quoter Uniswap lists for Robinhood Chain (4663) on developers.uniswap.org. It replaces the
// MixedRouteQuoterV2 (0x7edd862aa08dD5Be664C21188E1A2A0E64e3A283) this app used until 2026-10-12; for the same
// pool and amounts both return identical amountOut (checked at 0.001, 0.05 and 2 ETH). Like the router, it is
// not callable as a view: it reverts internally to produce the quote, so it is read through eth_call/simulate.
export const V4_QUOTER_ADDRESS: Address = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';

export const v4QuoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
