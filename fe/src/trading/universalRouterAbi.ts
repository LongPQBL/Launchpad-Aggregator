import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Universal Router 2.1.2, the address Uniswap lists for Robinhood Chain (4663) in universal-router's
// deploy-addresses/robinhood.json and on developers.uniswap.org. It replaces 2.1.1
// (0x8876789976decbfcbbbe364623c63652db8c0904, which users' swaps through this app used until 2026-10-12): same
// ABI and calldata, source byte-identical, only the pinned v4-periphery differs. Checked with eth_call against real
// V3 and V4 pools: both versions succeed with a minimum output of 1 and revert with an unreachable minimum.
export const UNIVERSAL_ROUTER_ADDRESS: Address = '0x204FAca1764B154221e35c0d20aBb3c525710498';

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
