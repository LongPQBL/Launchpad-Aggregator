import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Canonical CREATE2 cross-chain Permit2 address — confirmed deployed on Robinhood Chain via
// eth_getCode during docs/superpowers/specs/2026-10-07-v4-pool-swap-design.md's research (real
// bytecode, 18,306 hex chars, not empty).
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// AllowanceTransfer only — this app's Permit2 flow never uses SignatureTransfer (see the spec's
// "Approval architecture" section for why: Universal Router's real PERMIT2_PERMIT command and
// V4Router's own settlement path both use IAllowanceTransfer, confirmed by reading
// Dispatcher.sol and V4SwapRouter.sol/Permit2Payments.sol directly, not guessed).
export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
]);
