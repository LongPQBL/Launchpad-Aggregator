import { decodeAbiParameters, getAddress, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { encodeExecuteCommands, encodePermit2PermitInput, encodeV4SwapInput } from './v4SwapEncoding';

const poolKey = {
  currency0: '0xc9e9ab90654f82893d7fd18b62f694992e8cef29' as const,
  currency1: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as const,
  fee: 0,
  tickSpacing: 200,
  hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as const,
};

// viem's decodeAbiParameters always returns addresses in checksummed (mixed-case) form
// regardless of the case they were encoded with — confirmed against the installed viem
// 2.56.9 with a standalone encode/decode round-trip. The lowercase literals above are kept
// as-is (they are valid, case-insensitive addresses used for encoding); comparisons against
// *decoded* addresses below go through getAddress() so they assert on value, not casing.

describe('encodeExecuteCommands', () => {
  it('encodes just V4_SWAP (0x10) when no permit is needed', () => {
    expect(encodeExecuteCommands({ needsPermit: false })).toBe('0x10');
  });

  it('encodes PERMIT2_PERMIT (0x0a) before V4_SWAP (0x10) when a permit is needed', () => {
    expect(encodeExecuteCommands({ needsPermit: true })).toBe('0x0a10');
  });
});

describe('encodeV4SwapInput', () => {
  it('encodes actions as SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL in order', () => {
    const input = encodeV4SwapInput({ poolKey, zeroForOne: true, amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 1n });
    const [actions] = decodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), input);
    expect(actions).toBe('0x060c0f');
  });

  it('encodes the swap params with the real pool key, direction, and amounts', () => {
    const input = encodeV4SwapInput({ poolKey, zeroForOne: true, amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 42n });
    const [, params] = decodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), input);
    const [swapParams] = decodeAbiParameters(
      parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)'),
      params[0],
    );
    expect(swapParams).toEqual({
      poolKey: {
        currency0: getAddress(poolKey.currency0),
        currency1: getAddress(poolKey.currency1),
        fee: 0,
        tickSpacing: 200,
        hooks: getAddress(poolKey.hooks),
      },
      zeroForOne: true, amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 42n, minHopPriceX36: 0n, hookData: '0x',
    });
  });

  it('settles the real input currency (currency0 when zeroForOne) for the full amountIn', () => {
    const input = encodeV4SwapInput({ poolKey, zeroForOne: true, amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 1n });
    const [, params] = decodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), input);
    const [currency, amount] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[1]);
    expect(currency).toBe(getAddress(poolKey.currency0));
    expect(amount).toBe(1_000_000_000_000_000_000n);
  });

  it('takes the real output currency (currency1 when zeroForOne) for at least amountOutMinimum', () => {
    const input = encodeV4SwapInput({ poolKey, zeroForOne: true, amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 42n });
    const [, params] = decodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), input);
    const [currency, amount] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[2]);
    expect(currency).toBe(getAddress(poolKey.currency1));
    expect(amount).toBe(42n);
  });

  it('swaps which currency is settled vs taken when zeroForOne is false', () => {
    const input = encodeV4SwapInput({ poolKey, zeroForOne: false, amountIn: 5n, amountOutMinimum: 1n });
    const [, params] = decodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), input);
    const [settleCurrency] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[1]);
    const [takeCurrency] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[2]);
    expect(settleCurrency).toBe(getAddress(poolKey.currency1));
    expect(takeCurrency).toBe(getAddress(poolKey.currency0));
  });
});

describe('encodePermit2PermitInput', () => {
  it('round-trips the PermitSingle struct and signature', () => {
    const permitSingle = {
      details: { token: poolKey.currency0, amount: 1_000_000_000_000_000_000n, expiration: 1_800_000_000, nonce: 3 },
      spender: '0x8876789976decbfcbbbe364623c63652db8c0904' as const,
      sigDeadline: 1_800_000_600n,
    };
    const signature = '0x1234' as const;
    const input = encodePermit2PermitInput(permitSingle, signature);
    const [decodedPermit, decodedSignature] = decodeAbiParameters(
      parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature'),
      input,
    );
    expect(decodedPermit).toEqual({
      details: { ...permitSingle.details, token: getAddress(permitSingle.details.token) },
      spender: getAddress(permitSingle.spender),
      sigDeadline: permitSingle.sigDeadline,
    });
    expect(decodedSignature).toBe(signature);
  });
});
