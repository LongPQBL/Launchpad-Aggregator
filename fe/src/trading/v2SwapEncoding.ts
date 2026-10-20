import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';

// Universal Router command 0x08, V2_SWAP_EXACT_IN. Universal Router 2.1.x takes six fields, the trailing per-hop price limit array (empty here: no
// limit), the same as its V3 command; the five-field shape of older routers reverts. Checked with an eth_call on this chain: the router's V2
// factory is this chain's V2 factory and it derives the real pair's address from it.
export const COMMAND_V2_SWAP_EXACT_IN = 0x08;

export function encodeV2SwapInput(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  payerIsUser: boolean;
  recipient: Address;
}): Hex {
  return encodeAbiParameters(
    parseAbiParameters('address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser, uint256[] minHopPriceX36'),
    [params.recipient, params.amountIn, params.amountOutMinimum, [params.tokenIn, params.tokenOut], params.payerIsUser, []],
  );
}
