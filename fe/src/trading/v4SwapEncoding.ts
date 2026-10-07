import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';

// Verified against Uniswap's real v4-periphery/universal-router source during this plan's spec
// research (not guessed): Dispatcher.sol's command dispatch and v4-periphery's Actions.sol.
const COMMAND_PERMIT2_PERMIT = 0x0a;
const COMMAND_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

function bytesOf(values: readonly number[]): Hex {
  return `0x${values.map((value) => value.toString(16).padStart(2, '0')).join('')}` as Hex;
}

// A single-hop exact-input swap command bundle: SWAP_EXACT_IN_SINGLE, then SETTLE_ALL (pay the
// full input), then TAKE_ALL (collect the output). TAKE_ALL has no explicit recipient parameter —
// V4Router defaults it to the top-level execute() caller's own address, so the swapped output
// always lands directly in the connected wallet, never requiring a separate claim step.
export function encodeV4SwapInput(params: {
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): Hex {
  const tokenIn = params.zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1;
  const tokenOut = params.zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0;

  const actions = bytesOf([ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]);

  const swapParams = encodeAbiParameters(
    parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)'),
    [{
      poolKey: params.poolKey,
      zeroForOne: params.zeroForOne,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      minHopPriceX36: 0n,
      hookData: '0x',
    }],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters('address, uint256'), [tokenIn, params.amountIn]);
  const takeParams = encodeAbiParameters(parseAbiParameters('address, uint256'), [tokenOut, params.amountOutMinimum]);

  return encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [actions, [swapParams, settleParams, takeParams]]);
}

export function encodePermit2PermitInput(permitSingle: PermitSingle, signature: Hex): Hex {
  return encodeAbiParameters(
    parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature'),
    [permitSingle, signature],
  );
}

export function encodeExecuteCommands(options: { needsPermit: boolean }): Hex {
  return options.needsPermit ? bytesOf([COMMAND_PERMIT2_PERMIT, COMMAND_V4_SWAP]) : bytesOf([COMMAND_V4_SWAP]);
}
