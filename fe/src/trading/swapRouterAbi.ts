import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Verified against a real on-chain transaction during
// docs/superpowers/specs/2026-10-06-v3-pool-swap-design.md's research: a direct call to this
// router with selector 0x5ae401dc (multicall) whose single inner call fully decoded as
// exactInputSingle with real, sane parameters (a real Pons-launched token swapped for this
// chain's WETH). This is also the exact address docs.ponsfamily.com names as "Swap Router" —
// independently corroborating it, despite an earlier spec deprioritizing it based on incomplete
// decoding (see that spec's "Rejected as a dependency" note, now superseded for this address).
// Independently re-confirmed on 2026-10-07 via a byte-level diff of this address's runtime
// bytecode on Robinhood Chain against Uniswap's canonical SwapRouter02 deployment on Ethereum
// mainnet (0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45, fetched from a public mainnet RPC): both
// are 48,996 hex chars, and every one of the 41 differing byte ranges is a 20-byte immutable
// address constant (WETH/factory/position-manager — the mainnet side includes
// 0x1F98431c8aD98523631AE4a59f267346ea31F984, Uniswap's well-known canonical V3 factory
// address). Every other byte of actual contract logic is identical — this is the real
// SwapRouter02 bytecode, deployed here with this chain's own WETH/factory/position-manager
// addresses substituted in.
export const SWAP_ROUTER_ADDRESS: Address = '0xcaf681a66d020601342297493863e78c959e5cb2';

export const swapRouterAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
