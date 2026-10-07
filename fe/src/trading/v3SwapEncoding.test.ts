import { decodeAbiParameters, getAddress, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  WETH_ADDRESS, MSG_SENDER, ADDRESS_THIS,
  packV3Path, encodeV3SwapInput, encodeWrapEthInput, encodeUnwrapWethInput, encodeExecuteCommands,
} from './v3SwapEncoding';

const tokenIn = '0x1111111111111111111111111111111111111111' as const;
const tokenOut = '0x2222222222222222222222222222222222222222' as const;

describe('packV3Path', () => {
  it('packs tokenIn + 3-byte fee + tokenOut with no separators, 43 bytes total', () => {
    const path = packV3Path(tokenIn, 10000, tokenOut);
    expect(path.length).toBe(2 + 43 * 2); // '0x' + 86 hex chars
    expect(path.slice(0, 42).toLowerCase()).toBe(tokenIn.toLowerCase());
    expect(path.slice(42, 48)).toBe('002710'); // 10000 decimal == 0x002710, padded to 3 bytes
    expect(path.slice(48).toLowerCase()).toBe(tokenOut.slice(2).toLowerCase());
  });
});

const SWAP_INPUT_ABI = parseAbiParameters(
  'address recipient, uint256 amount, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36',
);

describe('encodeV3SwapInput', () => {
  it('encodes the real six-field tuple Dispatcher.sol expects, including the trailing minHopPriceX36 array', () => {
    const input = encodeV3SwapInput({
      tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 42n,
      payerIsUser: true, recipient: MSG_SENDER,
    });
    const [recipient, amount, amountOutMin, path, payerIsUser, minHopPriceX36] = decodeAbiParameters(SWAP_INPUT_ABI, input);
    expect(recipient).toBe(getAddress(MSG_SENDER));
    expect(amount).toBe(1_000_000_000_000_000_000n);
    expect(amountOutMin).toBe(42n);
    expect((path as string).toLowerCase()).toBe(packV3Path(tokenIn, 10000, tokenOut).toLowerCase());
    expect(payerIsUser).toBe(true);
    expect(minHopPriceX36).toEqual([]);
  });

  it('honors payerIsUser: false and a recipient override (the native-ETH-in / native-ETH-out cases)', () => {
    const input = encodeV3SwapInput({
      tokenIn, tokenOut, fee: 500, amountIn: 1n, amountOutMinimum: 1n, payerIsUser: false, recipient: ADDRESS_THIS,
    });
    const [recipient, , , , payerIsUser] = decodeAbiParameters(SWAP_INPUT_ABI, input);
    expect(recipient).toBe(getAddress(ADDRESS_THIS));
    expect(payerIsUser).toBe(false);
  });
});

describe('encodeWrapEthInput / encodeUnwrapWethInput', () => {
  it('encodes recipient and amountMinimum as a plain (address, uint256) pair', () => {
    const wrapInput = encodeWrapEthInput({ recipient: ADDRESS_THIS, amountMinimum: 1_000n });
    const [wrapRecipient, wrapAmountMinimum] = decodeAbiParameters(parseAbiParameters('address, uint256'), wrapInput);
    expect(wrapRecipient).toBe(getAddress(ADDRESS_THIS));
    expect(wrapAmountMinimum).toBe(1_000n);

    const unwrapInput = encodeUnwrapWethInput({ recipient: MSG_SENDER, amountMinimum: 500n });
    const [unwrapRecipient, unwrapAmountMinimum] = decodeAbiParameters(parseAbiParameters('address, uint256'), unwrapInput);
    expect(unwrapRecipient).toBe(getAddress(MSG_SENDER));
    expect(unwrapAmountMinimum).toBe(500n);
  });
});

describe('encodeExecuteCommands', () => {
  it('encodes just V3_SWAP_EXACT_IN (0x00) for a plain, already-approved ERC20-ERC20 swap', () => {
    expect(encodeExecuteCommands({ needsPermit: false, nativeIn: false, nativeOut: false })).toBe('0x00');
  });

  it('prepends PERMIT2_PERMIT (0x0a) when a signature is needed', () => {
    expect(encodeExecuteCommands({ needsPermit: true, nativeIn: false, nativeOut: false })).toBe('0x0a00');
  });

  it('prepends WRAP_ETH (0x0b) for native-ETH-in, never alongside PERMIT2_PERMIT', () => {
    expect(encodeExecuteCommands({ needsPermit: false, nativeIn: true, nativeOut: false })).toBe('0x0b00');
  });

  it('appends UNWRAP_WETH (0x0c) for native-ETH-out, combinable with a leading PERMIT2_PERMIT', () => {
    expect(encodeExecuteCommands({ needsPermit: true, nativeIn: false, nativeOut: true })).toBe('0x0a000c');
    expect(encodeExecuteCommands({ needsPermit: false, nativeIn: false, nativeOut: true })).toBe('0x000c');
  });
});

describe('WETH_ADDRESS', () => {
  it('matches the real, independently-verified WETH address on Robinhood Chain', () => {
    expect(WETH_ADDRESS.toLowerCase()).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
  });
});
