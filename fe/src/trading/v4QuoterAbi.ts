import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Universal Router's execute() has no return value (confirmed from IUniversalRouter.sol
// directly), so V3's "simulate the real submission call" quoting approach doesn't carry over to
// V4 — a dedicated quoter contract is required. Found by tracing Universal Router's real deployer
// transaction back to the sender that sequentially deployed this chain's entire official-style
// Uniswap stack (WETH, Permit2, the V3 factory, Position Manager, SwapRouter02, then Universal
// Router) in one burst, then independently verified with two live eth_call checks against this
// project's own real fixture pool (be/tests/fixtures/pons-v2-graduated.json) — both directions
// matched exactly. See the spec's "Quoting" section for the full numbers.
export const V4_QUOTER_ADDRESS: Address = '0x7edd862aa08dD5Be664C21188E1A2A0E64e3A283';

export const v4QuoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint256 exactAmount; bytes hookData; }',
  'function quoteExactInputSingleV4(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
