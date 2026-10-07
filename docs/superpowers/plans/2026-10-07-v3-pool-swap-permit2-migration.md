# V3 Pool Swap: Migrate to Universal Router + Permit2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the already-shipped V3 `SwapPanel` from direct `SwapRouter02` calls to Universal Router + Permit2 (mirroring the already-shipped V4 panel), and add a Uniswap-style token-selector UI that lets the user choose native ETH vs. WETH on whichever side of a V3 pool is the WETH leg.

**Architecture:** New `V3_QUOTER_ADDRESS` (a real, independently-verified `QuoterV2`) replaces the old `SwapRouter02`-simulation quote, fully decoupling quoting from approval state. Execution moves to `UniversalRouter.execute()` carrying `V3_SWAP_EXACT_IN` (+ `PERMIT2_PERMIT` when a signature is needed, + `WRAP_ETH`/`UNWRAP_WETH` when the user opts into native ETH). A new `TokenSelector` component (button + dropdown, reusing the existing `TokenLogo`) renders on both sides of the panel always, listing one entry for a pool's fixed token or two (ETH, WETH) for its WETH leg.

**Tech Stack:** Next.js, React, TypeScript, wagmi, viem, Vitest + Testing Library (all already in use in `fe/src/trading/`).

**Spec:** `docs/superpowers/specs/2026-10-07-v3-pool-swap-permit2-migration-design.md`

## Global Constraints

- `V3_QUOTER_ADDRESS = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` — real `QuoterV2`, function `quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)`.
- `WETH_ADDRESS = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (this chain's real WETH, already used BE-side).
- `UNIVERSAL_ROUTER_ADDRESS = 0x8876789976decbfcbbbe364623c63652db8c0904`, `PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3` — already defined in `universalRouterAbi.ts`/`permit2Abi.ts`, reuse as-is.
- Command bytes (real, source- and `eth_call`-verified): `V3_SWAP_EXACT_IN = 0x00`, `PERMIT2_PERMIT = 0x0a`, `WRAP_ETH = 0x0b`, `UNWRAP_WETH = 0x0c`.
- `V3_SWAP_EXACT_IN`'s real input tuple is **six fields**: `(address recipient, uint256 amount, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36)` — the trailing `minHopPriceX36` array is always `[]` in this plan (no per-hop limit). Do not use a five-field tuple; it silently misaligns every field after the first two.
- Sentinel recipients: `MSG_SENDER = 0x0000000000000000000000000000000000000001`, `ADDRESS_THIS = 0x0000000000000000000000000000000000000002`.
- Permit2 `ERC20 → Permit2` approval is `maxUint256`, never an exact amount — the per-trade authorization is the separate Permit2 `AllowanceTransfer`.
- No new shadcn `Dialog`/`Popover` dependency — the token-selector's dropdown uses the same hand-rolled `open`-state + absolutely-positioned-panel pattern already in `trade-settings-popover.tsx`.
- The token-selector always renders the same button-and-dropdown chrome on both sides of the panel, including when a side has exactly one valid token — never collapse it to plain text.
- No multi-hop, no platform fee, no EIP-5792 1-click bundling, no changes to `v4-swap-panel.tsx`.

## Review Focus

- A pool where neither side is WETH (e.g. a Pools-tab Token/USDG pair) must behave byte-identically to a plain ERC20-ERC20 swap — no `WRAP_ETH`/`UNWRAP_WETH` command may ever be injected, and both selectors must still render with exactly one inert option each.
- Flipping direction while the WETH leg is selected as native ETH must move the ETH/WETH selector to whichever side is now the WETH leg's current role (in vs. out) — not leave stale chrome on the side it used to be on.
- The `amountMinimum` passed to `UNWRAP_WETH` must be the exact same slippage-adjusted `amountOutMinimum` already computed for the swap itself — never recomputed, never left at `0`.
- A user who already holds a sufficient Permit2 allowance for a token, then switches that same token's side to native-ETH-in, must see Swap become immediately actionable with no stale "Approve" button and no Permit2 signature requested.
- The quote must stay disabled while the pool's fee tier is still unknown (`fee === null`) — never fire a request with a guessed fee tier.

---

## Task 1: `v3SwapEncoding.ts` — pure encoding helpers

**Files:**
- Create: `fe/src/trading/v3SwapEncoding.ts`
- Test: `fe/src/trading/v3SwapEncoding.test.ts`

**Interfaces:**
- Produces (consumed by Task 4): `WETH_ADDRESS: Address`, `MSG_SENDER: Address`, `ADDRESS_THIS: Address`, `packV3Path(tokenIn: Address, fee: number, tokenOut: Address): Hex`, `encodeV3SwapInput(params: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; amountOutMinimum: bigint; payerIsUser: boolean; recipient: Address }): Hex`, `encodeWrapEthInput(params: { recipient: Address; amountMinimum: bigint }): Hex`, `encodeUnwrapWethInput(params: { recipient: Address; amountMinimum: bigint }): Hex`, `encodeExecuteCommands(options: { needsPermit: boolean; nativeIn: boolean; nativeOut: boolean }): Hex`.

- [ ] **Step 1: Write the failing tests**

```ts
// fe/src/trading/v3SwapEncoding.test.ts
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
    expect(path.slice(48).toLowerCase()).toBe(tokenOut.toLowerCase());
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd fe && npx vitest run src/trading/v3SwapEncoding.test.ts`
Expected: FAIL with "Cannot find module './v3SwapEncoding'"

- [ ] **Step 3: Write the implementation**

```ts
// fe/src/trading/v3SwapEncoding.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fe && npx vitest run src/trading/v3SwapEncoding.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/v3SwapEncoding.ts src/trading/v3SwapEncoding.test.ts
git commit -m "$(cat <<'EOF'
feat(fe): add V3 Universal Router encoding helpers

Real Commands.sol/Dispatcher.sol command bytes and the V3_SWAP_EXACT_IN
six-field input tuple (including the minHopPriceX36 trailing array this
plan's spec research found missing from the first draft), WRAP_ETH/
UNWRAP_WETH encoding, and this chain's real WETH address.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J6tkNnewxao38Lmj3sz8Fa
EOF
)"
```

---

## Task 2: `v3QuoterAbi.ts` + `use-v3-swap-quote.ts` — the new quoting path

**Files:**
- Create: `fe/src/trading/v3QuoterAbi.ts`
- Create: `fe/src/trading/use-v3-swap-quote.ts`
- Test: `fe/src/trading/use-v3-swap-quote.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (consumed by Task 4): `V3_QUOTER_ADDRESS: Address`, `v3QuoterAbi` (viem `Abi`), `useV3SwapQuote(params: { tokenIn: Address | undefined; tokenOut: Address | undefined; fee: number | null; amountIn: bigint }): { outputAmount: bigint | null; isLoading: boolean; errorMessage: string | null }`.

- [ ] **Step 1: Write `v3QuoterAbi.ts` (no test — a declarative ABI/address file, same convention as the existing untested `v4QuoterAbi.ts`)**

```ts
// fe/src/trading/v3QuoterAbi.ts
import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Real, standard Uniswap QuoterV2 — independently verified on Robinhood Chain with two live
// eth_calls against the project's own fixture pool (be/tests/fixtures/pons-v1-reference.json's
// 0x10cc6bd38112cac182db90b6a71d8bb5939526ba): both directions' amountOut and gasEstimate
// matched exactly across two separate calls. See
// docs/superpowers/specs/2026-10-07-v3-pool-swap-permit2-migration-design.md's "The blocker
// this spec resolves, and how" section for the full numbers. Unlike V4_QUOTER_ADDRESS
// (v4QuoterAbi.ts), this is a genuine QuoterV2 with real V3 support — confirmed only after three
// different V3-shaped signatures failed against V4_QUOTER_ADDRESS itself.
export const V3_QUOTER_ADDRESS: Address = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';

export const v3QuoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
```

- [ ] **Step 2: Write the failing test for `use-v3-swap-quote.ts`**

```ts
// fe/src/trading/use-v3-swap-quote.test.ts
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useV3SwapQuote } from './use-v3-swap-quote';

const hooks = vi.hoisted(() => ({
  data: undefined as { result: readonly [bigint, bigint, number, bigint] } | undefined,
  isLoading: false,
  error: null as Error | null,
  simulateArgs: undefined as unknown,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useSimulateContract: (args: unknown) => {
    hooks.simulateArgs = args;
    return { data: hooks.data, isLoading: hooks.isLoading, error: hooks.error };
  },
}));

const tokenIn = '0x1111111111111111111111111111111111111111' as const;
const tokenOut = '0x2222222222222222222222222222222222222222' as const;

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useV3SwapQuote', () => {
  it('returns the quoted output amount (the first return value, not sqrtPriceX96After/gasEstimate)', () => {
    hooks.data = { result: [500_000n, 123n, 1, 96_633n] };
    const { result } = renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000n }));
    expect(result.current.outputAmount).toBe(500_000n);
  });

  it('disables the quote for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 0n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('disables the quote while the pool fee is not yet known, never guessing a fee tier', () => {
    renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: null, amountIn: 1_000_000n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('passes the real tokenIn, tokenOut, amountIn, and fee through, with no sqrtPriceLimitX96 restriction', () => {
    renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000n }));
    const args = hooks.simulateArgs as { args: [{ tokenIn: string; tokenOut: string; amountIn: bigint; fee: number; sqrtPriceLimitX96: bigint }] };
    expect(args.args[0]).toEqual({ tokenIn, tokenOut, amountIn: 1_000_000n, fee: 10000, sqrtPriceLimitX96: 0n });
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('pool does not exist');
    const { result } = renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000n }));
    expect(result.current.errorMessage).toBe('pool does not exist');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-v3-swap-quote.test.ts`
Expected: FAIL with "Cannot find module './use-v3-swap-quote'"

- [ ] **Step 4: Write the implementation**

```ts
// fe/src/trading/use-v3-swap-quote.ts
'use client';

import type { Address } from 'viem';
import { useSimulateContract } from 'wagmi';
import { v3QuoterAbi, V3_QUOTER_ADDRESS } from './v3QuoterAbi';
import { decodeTradeError } from './decodeTradeError';

export interface V3SwapQuoteParams {
  tokenIn: Address | undefined;
  tokenOut: Address | undefined;
  fee: number | null;
  amountIn: bigint;
}

export interface V3SwapQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

// Unlike the old use-swap-quote.ts this replaces, this quote is fully decoupled from the
// connected account's approval state — V3_QUOTER_ADDRESS needs no allowance at all (see the
// spec's "The blocker this spec resolves" section), so there is no recipient/account parameter
// and no need for use-refetch-quote-after-approval.ts's pre-approval-revert workaround.
export function useV3SwapQuote({ tokenIn, tokenOut, fee, amountIn }: V3SwapQuoteParams): V3SwapQuoteResult {
  const enabled = Boolean(tokenIn && tokenOut && fee !== null && amountIn > 0n);
  const { data, isLoading, error } = useSimulateContract({
    address: V3_QUOTER_ADDRESS,
    abi: v3QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: enabled ? [{
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      amountIn,
      fee: fee as number,
      sqrtPriceLimitX96: 0n,
    }] : undefined,
    query: { enabled },
  });

  return {
    // data.result is [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] —
    // only amountOut is ever shown to a user or used to compute amountOutMinimum.
    outputAmount: data?.result?.[0] ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd fe && npx vitest run src/trading/use-v3-swap-quote.test.ts`
Expected: PASS, all tests green

- [ ] **Step 6: Commit**

```bash
cd fe && git add src/trading/v3QuoterAbi.ts src/trading/use-v3-swap-quote.ts src/trading/use-v3-swap-quote.test.ts
git commit -m "$(cat <<'EOF'
feat(fe): add V3 quote hook against the real, independently-verified QuoterV2

Replaces the SwapRouter02-simulation quote approach, which depends on a
direct SwapRouter02 allowance that the upcoming Permit2 migration removes.
V3_QUOTER_ADDRESS needs no allowance at all, so this quote is fully
decoupled from approval state from the start.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J6tkNnewxao38Lmj3sz8Fa
EOF
)"
```

---

## Task 3: `TokenSelector` component

**Files:**
- Create: `fe/src/trading/token-selector.tsx`
- Test: `fe/src/trading/token-selector.test.tsx`

**Interfaces:**
- Consumes: `TokenLogo` from `@/features/launches/token-logo` (existing, `{ logoUri: string | null; symbol: string; chainId?: number }` props).
- Produces (consumed by Task 4): `TokenSelectorOption { key: string; symbol: string; logoUri: string | null }`, `TokenSelector(props: { options: readonly TokenSelectorOption[]; selected: TokenSelectorOption; onSelect: (key: string) => void; chainId?: number }): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

```tsx
// fe/src/trading/token-selector.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenSelector } from './token-selector';

const ethOption = { key: 'eth', symbol: 'ETH', logoUri: null };
const wethOption = { key: 'weth', symbol: 'WETH', logoUri: null };
const fixedOption = { key: '0x1111111111111111111111111111111111111111', symbol: 'LAUNCH', logoUri: null };

describe('TokenSelector', () => {
  it("shows the selected option's symbol on the trigger button", () => {
    render(<TokenSelector options={[ethOption, wethOption]} selected={ethOption} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /ETH/ })).toBeInTheDocument();
  });

  it('opens a dropdown listing every option when clicked', () => {
    render(<TokenSelector options={[ethOption, wethOption]} selected={ethOption} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ETH/ }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^ETH$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /WETH/ })).toBeInTheDocument();
  });

  it("calls onSelect with the clicked option's key and closes the dropdown", () => {
    const onSelect = vi.fn();
    render(<TokenSelector options={[ethOption, wethOption]} selected={ethOption} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /ETH/ }));
    fireEvent.click(screen.getByRole('option', { name: /WETH/ }));
    expect(onSelect).toHaveBeenCalledWith('weth');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('still renders the same button-and-dropdown chrome for a single-option list, not a plain label', () => {
    render(<TokenSelector options={[fixedOption]} selected={fixedOption} onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /LAUNCH/ });
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd fe && npx vitest run src/trading/token-selector.test.tsx`
Expected: FAIL with "Cannot find module './token-selector'"

- [ ] **Step 3: Write the implementation**

```tsx
// fe/src/trading/token-selector.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { TokenLogo } from '@/features/launches/token-logo';

export interface TokenSelectorOption {
  // Opaque identifier the panel uses to tell options apart — not necessarily an on-chain
  // address by itself (the ETH/WETH pair for a pool's WETH leg share one real address, so
  // 'eth'/'weth' string keys disambiguate them; a pool's other, fixed token uses its own address
  // as its key).
  key: string;
  symbol: string;
  logoUri: string | null;
}

export interface TokenSelectorProps {
  options: readonly TokenSelectorOption[];
  selected: TokenSelectorOption;
  onSelect: (key: string) => void;
  chainId?: number;
}

// Always renders the same button-and-dropdown chrome regardless of how many options exist —
// including the common case of exactly one (a pool's fixed, non-WETH side) — for visual
// consistency with Uniswap's own "Select a token" pattern. A single-option list is not a dead
// end to special-case away; selecting it is simply a no-op from the caller's perspective.
export function TokenSelector({ options, selected, onSelect, chainId }: TokenSelectorProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="flex items-center gap-1.5 rounded-full"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <TokenLogo logoUri={selected.logoUri} symbol={selected.symbol} chainId={chainId} />
        <span>{selected.symbol}</span>
        <span aria-hidden="true">▾</span>
      </Button>
      {open && (
        <ul role="listbox" className="absolute right-0 z-20 mt-2 w-40 rounded-md border border-border bg-card p-1 shadow-lg text-sm">
          {options.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                role="option"
                aria-selected={option.key === selected.key}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => { onSelect(option.key); setOpen(false); }}
              >
                <TokenLogo logoUri={option.logoUri} symbol={option.symbol} chainId={chainId} />
                {option.symbol}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fe && npx vitest run src/trading/token-selector.test.tsx`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/token-selector.tsx src/trading/token-selector.test.tsx
git commit -m "$(cat <<'EOF'
feat(fe): add TokenSelector component (button + dropdown, reuses TokenLogo)

Matches Uniswap's own "Select a token" UI pattern, per user-provided
reference screenshots: a logo+symbol+chevron button that opens a small
dropdown. Always renders this chrome, even for a single-option list —
the WETH-leg two-entry case is the exception, not the baseline shape.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J6tkNnewxao38Lmj3sz8Fa
EOF
)"
```

---

## Task 4: Rewrite `swap-panel.tsx` on Universal Router + Permit2 + TokenSelector

**Files:**
- Modify: `fe/src/trading/swap-panel.tsx` (full rewrite)
- Modify: `fe/src/trading/swap-panel.test.tsx` (full rewrite)

**Interfaces:**
- Consumes: from Task 1 — `WETH_ADDRESS`, `MSG_SENDER`, `ADDRESS_THIS`, `encodeV3SwapInput`, `encodeWrapEthInput`, `encodeUnwrapWethInput`, `encodeExecuteCommands`. From Task 2 — `useV3SwapQuote`. From Task 3 — `TokenSelector`, `TokenSelectorOption`. Pre-existing and unchanged: `usePoolFee` (`./use-pool-fee`), `usePermit2Permit` (`./use-permit2-permit`), `useTokenAllowance` (`./use-token-allowance`), `useTradeSettings`/`TradeSettingsPopover`, `useTradeSubmission`, `ApproveOrActionButton`, `TradeStatus`, `applySlippage`/`parseAmountSafe` (`./amount`), `universalRouterAbi`/`UNIVERSAL_ROUTER_ADDRESS` (`./universalRouterAbi`), `PERMIT2_ADDRESS` (`./permit2Abi`), `erc20Abi` (`./erc20Abi`), `encodePermit2PermitInput` (`./v4SwapEncoding` — generic PermitSingle encoding, not V4-specific despite the file name; reused directly rather than duplicated), `robinhoodChain` (`@/wallet/config`).
- Produces (consumed by Task 5): `SwapToken { address: Address; symbol: string | null; decimals: number; logoUri: string | null }` (note the new required `logoUri` field), `SwapPanelProps { poolAddress: Address; tokenA: SwapToken; tokenB: SwapToken; explorerBase: string | null }`, `SwapPanel(props: SwapPanelProps): JSX.Element` (same export name/shape as before, callers unaffected except for the new `logoUri` field on their token objects).

- [ ] **Step 1: Write the failing tests (full replacement of the existing file)**

```tsx
// fe/src/trading/swap-panel.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwapPanel, type SwapToken } from './swap-panel';

const SWAP_INPUT_ABI = parseAbiParameters(
  'address recipient, uint256 amount, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36',
);

function decodeV3SwapRecipient(swapInput: `0x${string}`): string {
  const [recipient] = decodeAbiParameters(SWAP_INPUT_ABI, swapInput);
  return (recipient as string).toLowerCase();
}

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  poolFee: 10000 as number | undefined,
  erc20Allowance: 0n,
  permit2Allowance: undefined as readonly [bigint, number, number] | undefined,
  permit2Refetch: vi.fn(async () => ({ data: hooks.permit2Allowance })),
  balanceA: 10_000_000_000_000_000_000n,
  balanceB: 10_000_000_000_000_000_000n,
  nativeBalance: 10_000_000_000_000_000_000n,
  simulateData: undefined as { result: readonly [bigint, bigint, number, bigint] } | undefined,
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  resetSignTypedData: vi.fn(),
  signTypedDataError: null as Error | null,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => ({ data: { value: hooks.nativeBalance }, isLoading: false }),
  useReadContract: (args: { functionName: string; address: string }) => {
    if (args.functionName === 'fee') return { data: hooks.poolFee, isLoading: false };
    if (args.functionName === 'allowance' && args.address?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3') {
      return { data: hooks.permit2Allowance, isLoading: false, refetch: hooks.permit2Refetch };
    }
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: false, error: hooks.signTypedDataError, reset: hooks.resetSignTypedData }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
}));

const poolAddress = '0x4444444444444444444444444444444444444444' as const;
const tokenA: SwapToken = { address: '0x1111111111111111111111111111111111111112', symbol: 'LAUNCH', decimals: 18, logoUri: null };
const tokenB: SwapToken = { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', decimals: 18, logoUri: null };
// A pair with no WETH leg at all (e.g. a Pools-tab Token/USDG pair) — for the "no native choice" cases.
const tokenNoWeth: SwapToken = { address: '0x3333333333333333333333333333333333333333', symbol: 'USDG', decimals: 18, logoUri: null };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.poolFee = 10000;
  hooks.erc20Allowance = 2_000_000_000_000_000_000n;
  hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
  hooks.permit2Refetch.mockReset();
  hooks.permit2Refetch.mockImplementation(async () => ({ data: hooks.permit2Allowance }));
  hooks.balanceA = 10_000_000_000_000_000_000n;
  hooks.balanceB = 10_000_000_000_000_000_000n;
  hooks.nativeBalance = 10_000_000_000_000_000_000n;
  hooks.simulateData = undefined;
  hooks.signTypedDataAsync.mockClear();
  hooks.resetSignTypedData.mockReset();
  hooks.signTypedDataError = null;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('SwapPanel', () => {
  it('defaults to swapping tokenA for tokenB, showing WETH\'s default native-ETH choice on the output side', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
    // tokenB is the WETH leg and useNativeEth defaults to true, so its selector shows ETH, not WETH.
    expect(screen.getByRole('button', { name: /^ETH$/ })).toBeInTheDocument();
  });

  it('flips direction when the toggle is clicked', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    // tokenA (not WETH) is now on the output side; tokenB (WETH, default ETH) is now on the input side.
    expect(screen.getAllByRole('button', { name: /^ETH$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
  });

  it('every side renders the token-selector chrome even when a pool has no WETH leg at all', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenNoWeth} explorerBase={null} />);
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /USDG/ })).toBeInTheDocument();
  });

  it('shows Approve (targeting Permit2, not a router) when the ERC20->Permit2 allowance is insufficient for a WETH-chosen (non-native) input', () => {
    // Select WETH (not ETH) on the input side so this is a plain ERC20 approval case.
    hooks.erc20Allowance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('approves maxUint256 to Permit2, never an exact amount', () => {
    hooks.erc20Allowance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'approve', args: [expect.any(String), 2n ** 256n - 1n] }),
    );
  });

  it('signs a Permit2 PermitSingle then submits execute() with PERMIT2_PERMIT+V3_SWAP_EXACT_IN, for a WETH-chosen (non-native) input needing a signature', async () => {
    hooks.permit2Allowance = [0n, 0, 2];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.signTypedDataAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', args: ['0x0a00', expect.arrayContaining([expect.any(String), expect.any(String)]), expect.anything()] }),
      expect.anything(),
    ));
  });

  it('submits execute() with just V3_SWAP_EXACT_IN, skipping the signature, when the Permit2 allowance already covers the trade', async () => {
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', args: ['0x00', expect.arrayContaining([expect.any(String)]), expect.anything()] }),
      expect.anything(),
    ));
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('sends value and skips both ERC20 approval and the Permit2 signature for a native-ETH-in input (the default WETH-leg choice)', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    // tokenB is WETH and the default is native ETH, so just flip direction to make it the input.
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', value: 1_000_000_000_000_000_000n }),
      expect.anything(),
    ));
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
    const [{ args }] = hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }];
    expect(args[0]).toBe('0x0b00'); // WRAP_ETH then V3_SWAP_EXACT_IN, no PERMIT2_PERMIT
  });

  it('appends UNWRAP_WETH and settles the swap itself to the router (ADDRESS_THIS), for a native-ETH-out output (the default WETH-leg choice)', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    // tokenB (WETH) stays the default output side; default useNativeEth=true makes this native-ETH-out.
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalled());
    const [{ args }] = hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }];
    expect(args[0]).toBe('0x000c'); // V3_SWAP_EXACT_IN then UNWRAP_WETH (allowance already sufficient, no permit)
    const swapInput = args[1][0];
    expect(decodeV3SwapRecipient(swapInput)).toBe('0x0000000000000000000000000000000000000002'); // ADDRESS_THIS
  });

  it('becomes immediately actionable with no Approve button and no signature when switching an already-Permit2-approved token to native-ETH-in', () => {
    // Full allowance/signature already sufficient for the ERC20 (WETH) form of this same token.
    hooks.erc20Allowance = 2_000_000_000_000_000_000n;
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i })); // WETH leg now "in"
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    // Default choice is already native ETH — Swap must be actionable directly, no Approve.
    expect(screen.getByRole('button', { name: 'Swap' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('disables Swap and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });

  it('disables Swap when the input-side balance is insufficient (native-ETH balance, the default WETH-leg choice)', () => {
    hooks.nativeBalance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i })); // WETH leg now "in"
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash and leaves Swap disabled when the amount contains scientific notation', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not leave an unhandled promise rejection when the wallet rejects the Permit2 signature', async () => {
    hooks.permit2Allowance = [0n, 0, 2];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    hooks.signTypedDataAsync.mockRejectedValueOnce(new Error('User rejected the request'));
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.signTypedDataAsync).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.writeContract).not.toHaveBeenCalled();
  });

  it('clears a stale Permit2 signature-rejection error as soon as a new submit begins, even one that needs no signature', async () => {
    hooks.signTypedDataError = new Error('User rejected the request');
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.resetSignTypedData).toHaveBeenCalled());
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd fe && npx vitest run src/trading/swap-panel.test.tsx`
Expected: FAIL — `SwapToken`'s `logoUri` field and the new token-selector buttons don't exist yet on the current implementation

- [ ] **Step 3: Write the implementation**

```tsx
// fe/src/trading/swap-panel.tsx
'use client';

import { useState } from 'react';
import { type Address, type Hex, formatUnits, maxUint256 } from 'viem';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import { PERMIT2_ADDRESS } from './permit2Abi';
import { usePoolFee } from './use-pool-fee';
import { useV3SwapQuote } from './use-v3-swap-quote';
import { usePermit2Permit } from './use-permit2-permit';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { ApproveOrActionButton } from './approve-or-action-button';
import { TradeStatus } from './trade-status';
import { TokenSelector, type TokenSelectorOption } from './token-selector';
import { applySlippage, parseAmountSafe } from './amount';
import { encodePermit2PermitInput } from './v4SwapEncoding';
import {
  WETH_ADDRESS, MSG_SENDER, ADDRESS_THIS,
  encodeV3SwapInput, encodeWrapEthInput, encodeUnwrapWethInput, encodeExecuteCommands,
} from './v3SwapEncoding';

export interface SwapToken {
  address: Address;
  symbol: string | null;
  decimals: number;
  // null when no logo is known for this address — the token-selector falls back to a letter
  // avatar (TokenImage's existing behavior), never a guessed or fabricated URL.
  logoUri: string | null;
}

export interface SwapPanelProps {
  poolAddress: Address;
  tokenA: SwapToken;
  tokenB: SwapToken;
  explorerBase: string | null;
}

function isWeth(token: SwapToken): boolean {
  return token.address.toLowerCase() === WETH_ADDRESS.toLowerCase();
}

export function SwapPanel({ poolAddress, tokenA, tokenB, explorerBase }: SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  const [amount, setAmount] = useState('');
  // Governs the ETH/WETH choice on whichever side currently holds the WETH leg (if any) — a
  // single boolean, not per-direction, since flipping direction only changes whether that leg
  // is currently "in" or "out", never which side it's on. Irrelevant when neither tokenA nor
  // tokenB is WETH.
  const [useNativeEth, setUseNativeEth] = useState(true);
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;
  const { fee } = usePoolFee(poolAddress);

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const amountIn = parseAmountSafe(amount, tokenIn.decimals);

  const nativeIn = useNativeEth && isWeth(tokenIn);
  const nativeOut = useNativeEth && isWeth(tokenOut);

  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) && !nativeIn },
  });
  const nativeBalance = useBalance({ address: account, query: { enabled: nativeIn && Boolean(account) } });
  const erc20Allowance = useTokenAllowance(nativeIn ? undefined : tokenIn.address, PERMIT2_ADDRESS);
  const permit2 = usePermit2Permit(nativeIn ? undefined : tokenIn.address, UNIVERSAL_ROUTER_ADDRESS, amountIn);
  const quote = useV3SwapQuote({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee, amountIn });
  const submission = useTradeSubmission();
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = nativeIn
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (tokenInBalance ?? 0n) < amountIn;
  const needsErc20Approval = !nativeIn && amountIn > 0n && !hasInsufficientBalance && erc20Allowance.allowance < amountIn;

  function displaySymbol(token: SwapToken, isCurrentlyNative: boolean): string {
    if (isWeth(token) && isCurrentlyNative) return 'ETH';
    return token.symbol ?? 'token';
  }

  async function submitSwap() {
    // Clear any stale signature-rejection error from a previous attempt as soon as a new submit
    // begins, regardless of outcome — same reasoning as v4-swap-panel.tsx's identical guard.
    permit2.resetSignError();
    if (amountIn === 0n || !account || quote.outputAmount === null || fee === null) return;
    const amountOutMinimum = applySlippage(quote.outputAmount, settings.slippageBps, 'pool');

    let permitInput: Hex | null = null;
    if (!nativeIn && permit2.needsPermit) {
      // signPermit() calls signTypedDataAsync, which throws when the user rejects the wallet's
      // signature request. submitSwap is invoked as `void submitSwap()` from the UI, so an
      // uncaught throw here would become an unhandled promise rejection.
      let signed;
      try {
        signed = await permit2.signPermit();
      } catch {
        return;
      }
      if (!signed) return;
      permitInput = encodePermit2PermitInput(signed.permitSingle, signed.signature);
    }

    const swapInput = encodeV3SwapInput({
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      fee,
      amountIn,
      amountOutMinimum,
      payerIsUser: !nativeIn,
      recipient: nativeOut ? ADDRESS_THIS : MSG_SENDER,
    });
    const wrapInput = nativeIn ? encodeWrapEthInput({ recipient: ADDRESS_THIS, amountMinimum: amountIn }) : null;
    const unwrapInput = nativeOut ? encodeUnwrapWethInput({ recipient: MSG_SENDER, amountMinimum: amountOutMinimum }) : null;

    const commands = encodeExecuteCommands({ needsPermit: permitInput !== null, nativeIn, nativeOut });
    const inputs = [
      ...(permitInput ? [permitInput] : []),
      ...(wrapInput ? [wrapInput] : []),
      swapInput,
      ...(unwrapInput ? [unwrapInput] : []),
    ];
    // Floor the whole computed deadline, not just the current-timestamp half — a fractional
    // settings.deadlineMinutes otherwise makes the sum non-integer, and BigInt() throws a
    // RangeError on a non-integer number (same fix already applied in the V4 panel).
    const deadline = BigInt(Math.floor(Date.now() / 1000 + settings.deadlineMinutes * 60));

    submission.submit(
      {
        address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute',
        args: [commands, inputs, deadline],
        value: nativeIn ? amountIn : undefined,
      },
      { onSuccess: () => setAmount('') },
    );
  }

  function sideOptions(token: SwapToken): readonly TokenSelectorOption[] {
    if (!isWeth(token)) return [{ key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri }];
    return [
      { key: 'eth', symbol: 'ETH', logoUri: null },
      { key: 'weth', symbol: 'WETH', logoUri: token.logoUri },
    ];
  }

  function selectedOption(token: SwapToken): TokenSelectorOption {
    if (!isWeth(token)) return { key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri };
    return useNativeEth
      ? { key: 'eth', symbol: 'ETH', logoUri: null }
      : { key: 'weth', symbol: 'WETH', logoUri: token.logoUri };
  }

  function handleSelect(token: SwapToken, key: string) {
    // Selecting the pool's single fixed (non-WETH) token is a no-op — there is nothing else it
    // could become. Only a WETH-leg side's 'eth'/'weth' choice actually changes state, and it's
    // the one shared useNativeEth boolean regardless of which side (in or out) it's on.
    if (isWeth(token)) setUseNativeEth(key === 'eth');
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="flex-1 text-sm">Sell</span>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="pool" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} className="flex-1" />
        <TokenSelector
          options={sideOptions(tokenIn)}
          selected={selectedOption(tokenIn)}
          onSelect={(key) => handleSelect(tokenIn, key)}
          chainId={robinhoodChain.id}
        />
      </div>
      <Button type="button" variant="ghost" size="sm" aria-label="Flip swap direction"
        onClick={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); setAmount(''); }}>
        ⇅
      </Button>
      <div className="flex items-center justify-between gap-2">
        <span className="flex-1 text-sm text-muted-foreground">
          {quote.outputAmount !== null
            ? `You receive ≈ ${formatUnits(quote.outputAmount, tokenOut.decimals)} ${displaySymbol(tokenOut, nativeOut)}`
            : amountIn > 0n && quote.errorMessage ? `Quote unavailable: ${quote.errorMessage}` : ''}
        </span>
        <TokenSelector
          options={sideOptions(tokenOut)}
          selected={selectedOption(tokenOut)}
          onSelect={(key) => handleSelect(tokenOut, key)}
          chainId={robinhoodChain.id}
        />
      </div>
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {!isWrongChain && amountIn > 0n && hasInsufficientBalance && (
        <p className="text-sm text-destructive">Insufficient {displaySymbol(tokenIn, nativeIn)} balance.</p>
      )}
      {permit2.signError && (
        <p role="alert" className="text-sm text-destructive">
          {permit2.signError}
        </p>
      )}
      <ApproveOrActionButton
        needsApproval={needsErc20Approval}
        amountIn={amountIn}
        approveAmount={maxUint256}
        isWrongChain={isWrongChain}
        hasInsufficientBalance={hasInsufficientBalance}
        outputAmount={quote.outputAmount}
        isSubmitting={isSubmitting || permit2.isSigning}
        allowance={erc20Allowance}
        actionLabel="Swap"
        onAction={() => { void submitSwap(); }}
      />
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fe && npx vitest run src/trading/swap-panel.test.tsx`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/swap-panel.tsx src/trading/swap-panel.test.tsx
git commit -m "$(cat <<'EOF'
feat(fe): migrate V3 SwapPanel to Universal Router + Permit2 + TokenSelector

Mirrors v4-swap-panel.tsx's approval/execution architecture (one-time
ERC20->Permit2 max approval, per-trade PermitSingle signature when
needed) and adds a new ETH/WETH TokenSelector on both sides of the panel.
SwapToken gains a required logoUri field for the selector's icons.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J6tkNnewxao38Lmj3sz8Fa
EOF
)"
```

---

## Task 5: Remove dead V3-router code, update call sites, full verification

**Files:**
- Delete: `fe/src/trading/swapRouterAbi.ts`
- Delete: `fe/src/trading/use-swap-quote.ts`
- Delete: `fe/src/trading/use-swap-quote.test.ts`
- Modify: `fe/src/features/pools/pool-detail.tsx`
- Modify: `fe/src/features/launch/launch-detail.tsx`

**Interfaces:**
- Consumes: `SwapToken` from Task 4 (its new required `logoUri` field).
- Produces: nothing further — this is the integration/cleanup task.

- [ ] **Step 1: Confirm no other file still references the files being deleted**

Run: `cd fe && grep -rln "swapRouterAbi\|use-swap-quote" src/ | grep -v "src/trading/swapRouterAbi.ts\|src/trading/use-swap-quote"`
Expected: no output (only the files being deleted themselves match)

- [ ] **Step 2: Delete the dead files**

```bash
cd fe && rm src/trading/swapRouterAbi.ts src/trading/use-swap-quote.ts src/trading/use-swap-quote.test.ts
```

- [ ] **Step 3: Update `pool-detail.tsx`'s `SwapPanel` call to pass `logoUri`**

In `fe/src/features/pools/pool-detail.tsx`, find the existing `<SwapPanel ...>` call (currently passing `tokenA`/`tokenB` without `logoUri`) and add the field, reusing the same `currency0LogoUri`/`currency1LogoUri` fields `PoolLogo` already consumes a few lines above it:

```tsx
        <SwapPanel
          poolAddress={pool.poolId as `0x${string}`}
          tokenA={{ address: pool.currency0 as `0x${string}`, symbol: pool.currency0Symbol, decimals: pool.currency0Decimals, logoUri: pool.currency0LogoUri }}
          tokenB={{ address: pool.currency1 as `0x${string}`, symbol: pool.currency1Symbol, decimals: pool.currency1Decimals, logoUri: pool.currency1LogoUri }}
          explorerBase={explorerBase ?? null}
        />
```

- [ ] **Step 4: Update `launch-detail.tsx`'s `SwapPanel` call to pass `logoUri`**

In `fe/src/features/launch/launch-detail.tsx`, find the existing `<SwapPanel ...>` call and add `logoUri`. The launch's own token has a real logo (`detail.logoUri`, already used a few lines above for the page header's `TokenLogo`); the quote asset does not currently expose one through this endpoint, so it is explicitly `null` (the token-selector's existing letter-fallback handles this, same as any other unresolved logo elsewhere in the app — not a new gap this task introduces):

```tsx
              <SwapPanel
                poolAddress={activeV3Venue.ref as `0x${string}`}
                tokenA={{ address: detail.tokenAddress as `0x${string}`, symbol: displaySymbol(detail.symbol), decimals: detail.tokenDecimals, logoUri: detail.logoUri }}
                tokenB={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals, logoUri: null }}
                explorerBase={explorerBase ?? null}
              />
```

- [ ] **Step 5: Run the full frontend verification suite**

Run: `cd fe && npx tsc --noEmit`
Expected: no errors

Run: `cd fe && npx eslint src/trading src/features/pools/pool-detail.tsx src/features/launch/launch-detail.tsx`
Expected: no errors (pre-existing, unrelated warnings elsewhere in the repo are out of scope)

Run: `cd fe && npx vitest run`
Expected: all tests pass, including `pool-detail.test.tsx` and `launch-detail.test.tsx` (unmodified by this task, but exercising the now-required `logoUri` field through the real component — if either test's own `pool`/`detail` fixtures don't already include `currency0LogoUri`/`currency1LogoUri`/`logoUri`, this is where a gap would surface; fix by adding those fields to the fixture, not by loosening `SwapToken`'s type)

- [ ] **Step 6: Commit**

```bash
cd fe && git add -A src/trading/swapRouterAbi.ts src/trading/use-swap-quote.ts src/trading/use-swap-quote.test.ts src/features/pools/pool-detail.tsx src/features/launch/launch-detail.tsx
git commit -m "$(cat <<'EOF'
chore(fe): remove dead SwapRouter02 V3 code, wire logoUri into SwapPanel call sites

swapRouterAbi.ts and use-swap-quote.ts have no remaining consumers now
that swap-panel.tsx uses Universal Router + the new V3 quoter. Both
SwapPanel call sites now pass the new required logoUri field — real
values where already available (pool currencies, the launch's own
token), explicit null where not (a launch's quote asset has no logoUri
in the current API response — a known, accepted gap, not fabricated).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J6tkNnewxao38Lmj3sz8Fa
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:** Quoting blocker (Task 2), execution command/tuple shape (Task 1), approval flow (Task 4, reuses existing hooks unchanged), native-ETH in/out (Task 4), token-selector UI always-rendered-both-sides (Task 3 + Task 4), file deletions (Task 5), call-site `logoUri` wiring (Task 5) — every spec section maps to a task.

**Placeholder scan:** none found — every step has real, complete code.

**Type consistency:** `SwapToken`, `TokenSelectorOption`, `encodeV3SwapInput`/`encodeWrapEthInput`/`encodeUnwrapWethInput`/`encodeExecuteCommands` signatures are identical between their defining task and every consuming task.

**Review Focus coverage:** no-WETH-leg pool (Task 4 test "every side renders the token-selector chrome even when a pool has no WETH leg at all"), direction-flip chrome movement (Task 4 test "flips direction when the toggle is clicked" + the native-ETH-in/out tests which flip first), `UNWRAP_WETH` amountMinimum correctness (Task 4 test "appends UNWRAP_WETH and settles the swap itself to the router" — decodes the real swap recipient; the shared `amountOutMinimum` variable feeding both the swap and the unwrap call is the same code path by construction, not a separate computation to drift), already-approved-token-switches-to-native (Task 4 test "becomes immediately actionable..."), fee-still-null quote gating (Task 2 test "disables the quote while the pool fee is not yet known").
