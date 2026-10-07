import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Found by decoding the real PoolManager Swap event's own `sender` field (the direct caller of
// PoolManager.swap(), not the top-level tx.to, which is usually obscured by ERC-4337 account
// abstraction on this chain) across real V4 user-trade transactions — see the spec's "Protocol
// research" section. Confirmed functionally: contains both documented execute() selectors
// (0x3593564c, 0x24856bc3) and a live eth_call to execute(0x, [], <future deadline>) returned
// 0x success, the documented no-op behavior of a real Universal Router.
export const UNIVERSAL_ROUTER_ADDRESS: Address = '0x8876789976decbfcbbbe364623c63652db8c0904';

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
