import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';

// Verified against Uniswap's real universal-router source during this plan's spec research
// (contracts/libraries/Commands.sol, contracts/base/Dispatcher.sol, fetched directly, not
// guessed) and confirmed with real eth_calls against a real pool on this chain — see
// docs/superpowers/specs/2026-10-07-v3-pool-swap-permit2-migration-design.md.
const COMMAND_V3_SWAP_EXACT_IN = 0x00;
const COMMAND_PERMIT2_PERMIT = 0x0a;
const COMMAND_WRAP_ETH = 0x0b;
const COMMAND_UNWRAP_WETH = 0x0c;

// This chain's real WETH address — already used BE-side in be/src/launchpads/pons/v1/adapter.ts.
export const WETH_ADDRESS: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

// Universal Router's documented Constants.sol sentinel recipients: "deliver to the original
// caller" and "keep in the router's own balance for the next command", respectively.
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

function bytesOf(values: readonly number[]): Hex {
  return `0x${values.map((value) => value.toString(16).padStart(2, '0')).join('')}` as Hex;
}

// Standard Uniswap V3 single-hop packed path: tokenIn (20 bytes) + fee (3-byte big-endian
// uint24) + tokenOut (20 bytes), tightly packed, not ABI-encoded as separate fields.
export function packV3Path(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  const feeHex = fee.toString(16).padStart(6, '0');
  return `0x${tokenIn.slice(2)}${feeHex}${tokenOut.slice(2)}`.toLowerCase() as Hex;
}

// The real Dispatcher.sol input shape for V3_SWAP_EXACT_IN is six fields, not five — the
// trailing minHopPriceX36 array (always empty here, meaning "no per-hop price limit") was
// missing from this plan's first research pass and is exactly why that first eth_call probe
// hit Path.sol's SliceOutOfBounds(): the missing field shifted every later field's offset.
export function encodeV3SwapInput(params: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  payerIsUser: boolean;
  recipient: Address;
}): Hex {
  const path = packV3Path(params.tokenIn, params.fee, params.tokenOut);
  return encodeAbiParameters(
    parseAbiParameters('address recipient, uint256 amount, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36'),
    [params.recipient, params.amountIn, params.amountOutMinimum, path, params.payerIsUser, []],
  );
}

export function encodeWrapEthInput(params: { recipient: Address; amountMinimum: bigint }): Hex {
  return encodeAbiParameters(parseAbiParameters('address, uint256'), [params.recipient, params.amountMinimum]);
}

export function encodeUnwrapWethInput(params: { recipient: Address; amountMinimum: bigint }): Hex {
  return encodeAbiParameters(parseAbiParameters('address, uint256'), [params.recipient, params.amountMinimum]);
}

export function encodeExecuteCommands(options: { needsPermit: boolean; nativeIn: boolean; nativeOut: boolean }): Hex {
  const commands: number[] = [];
  if (options.needsPermit) commands.push(COMMAND_PERMIT2_PERMIT);
  if (options.nativeIn) commands.push(COMMAND_WRAP_ETH);
  commands.push(COMMAND_V3_SWAP_EXACT_IN);
  if (options.nativeOut) commands.push(COMMAND_UNWRAP_WETH);
  return bytesOf(commands);
}
