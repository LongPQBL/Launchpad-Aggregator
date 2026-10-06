# V3 Pool Swap on the Launch Detail Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a connected browser wallet Swap a V1 Pons launch's token against its graduated V3 pool, directly from the launch detail page — real on-chain execution, no router dependency beyond the one confirmed standard `SwapRouter02` deployment.

**Architecture:** Reuses almost all of the curve-trading module's shared infrastructure unchanged (`useTokenAllowance`, `useTradeSettings`, `useTradeSubmission`, `TradeStatus`, `decodeTradeError`). Adds: a shared amount-parsing/slippage helper extracted out of the existing Buy/Sell panels (now needed a third time), a `SwapRouter02` ABI (`multicall` wrapping `exactInputSingle`), a tiny V3-pool-contract ABI (`fee()` — read directly on-chain, no backend change needed), a quote hook, and one `SwapPanel` component with an internal direction toggle (unlike curve's separate Buy/Sell panels, V3's `exactInputSingle` is the same function regardless of direction — only `tokenIn`/`tokenOut` swap). `launch-detail.tsx` gains a second gate, alongside the existing curve gate, rendering `SwapPanel` for a V1 launch's active `v3_pool` venue.

**Scope boundary:** the Pools-tab Swap panel (any arbitrary V3 pool, not just a launch's own official venue) is explicitly **not** in this plan — it needs a backend addition this plan's research surfaced as missing (`currency0Decimals`/`currency1Decimals` do not currently exist anywhere in the Pool API, confirmed by grepping `be/src/api/schema.ts`), plus a direction-toggle UI generalized to two arbitrary tokens instead of "the launch's own token vs. its quote asset." Separate follow-up plan. V4 pool swap (Universal Router command encoding) is also out of scope, per the spec's own phasing.

**Tech Stack:** Next.js, React, TypeScript, Tailwind, shadcn/ui, Wagmi 3, viem 2, Vitest + Testing Library — same as the curve-trading plan.

**Spec:** `docs/superpowers/specs/2026-10-06-v3-pool-swap-design.md` (and its prerequisite, `docs/superpowers/specs/2026-10-06-launch-trading-design.md`)

## Global Constraints

- Never fabricate a price/quote or a decimals count — an unavailable or not-yet-computed value shows as unavailable (no panel at all), never a guess. This plan reuses `detail.tokenDecimals`/`detail.quoteAsset.decimals` (both already null-safe per the curve plan's Task 1) — never introduce a new guessed-decimals path.
- Approval is exact-amount by default, never infinite (already enforced in the reused `useTokenAllowance` — do not change that).
- No platform fee — submit the router's own `exactInputSingle` unmodified.
- Settings UI: Max slippage (Auto + custom) and Swap deadline both apply here (unlike curve, which hid the deadline control) — pass `venueKind="pool"` to `TradeSettingsPopover` wherever this plan's `SwapPanel` renders it.
- Real execution only — no simulated/paper-trading mode.
- Code identifiers, tests, comments are English.
- No automated test requires a real wallet extension or spends real funds.
- A double-click must never submit two real transactions; a reverted-but-mined transaction must show its real decoded reason, never a blank or generic message; the amount input must never crash the page on malformed text (e.g. scientific notation) — these are the exact classes of bug the curve-trading plan's final review found and fixed; this plan's `SwapPanel` must not reintroduce any of them. Every new hook that could end up calling a wagmi hook conditionally (e.g. based on swap direction) must instead call it unconditionally and select which result to use afterward — the curve plan's `use-curve-quote.ts` got this wrong once (a ternary selecting between two hook-call expressions, a genuine React Rules-of-Hooks violation only caught by `eslint`, not by mocked tests) and had to be fixed in a reopened task.

## Review Focus

- A V1 launch whose V3 pool venue is not currently active (`effectiveToBlock` set, not `null`) must not show the Swap panel — re-derive this from the real venue data, don't assume "a `v3_pool` venue row exists" is sufficient (verified during this plan's research: V1 launches don't have a curve-to-pool lifecycle transition the way V2 does, so no `lifecycleStatus` check is needed here, only the `effectiveToBlock === null` check — confirm the implementation doesn't add an unnecessary/wrong lifecycle condition by copying the curve gate verbatim).
- Submitting a Swap with an unresolved quote must be impossible (mirrors the curve plan's Important-severity final-review finding) — the Swap button's `disabled` condition must include "quote not yet resolved," from the first implementation, not added later via a fix loop.
- A reverted-but-mined Swap must surface its real on-chain reason, not a blank/generic message — reuse `use-trade-submission.ts` exactly as-is (already fixed for this in the curve plan); do not reimplement transaction-status tracking from scratch in a way that could reintroduce that bug.
- Both swap directions (launch-token-in vs. quote-asset-in) must each independently get: an allowance check (if the input side isn't native ETH), a balance check, and a wrong-chain guard — verify by testing both directions explicitly, not just one with the assumption the other "obviously" mirrors it.
- The pool's `fee` tier must come from the real pool contract's `fee()` read, never hardcoded or guessed — a wrong fee means `exactInputSingle` targets the wrong pool (V3 pools are keyed by `(token0, token1, fee)`; a wrong fee is a different pool, not an error) or reverts outright.

---

## Task 1: Extract shared amount-parsing and slippage helpers

**Files:**
- Create: `fe/src/trading/amount.ts`
- Modify: `fe/src/trading/buy-panel.tsx`
- Modify: `fe/src/trading/sell-panel.tsx`
- Test: `fe/src/trading/amount.test.ts`

**Interfaces:**
- Produces: `parseAmountSafe(amount: string, decimals: number): bigint`, `applySlippage(amount: bigint, slippageBps: number | 'auto', venueKind: 'curve' | 'pool'): bigint`.
- Consumes: `resolveAutoSlippageBps` (already exists, `fe/src/trading/use-trade-settings.ts`).

This is a pure refactor — no behavior change. `buy-panel.tsx` and `sell-panel.tsx` currently each define their own identical copy of `parseAmountSafe`, and their own `applySlippage` hardcoded to `'curve'`. Moving both to a shared file lets this plan's new `SwapPanel` (Task 5) use the same tested logic with `venueKind: 'pool'` instead of copy-pasting a third time.

- [ ] **Step 1: Write the failing test for the extracted module**

```typescript
// fe/src/trading/amount.test.ts
import { describe, expect, it } from 'vitest';
import { parseAmountSafe, applySlippage } from './amount';

describe('parseAmountSafe', () => {
  it('parses a plain decimal string', () => {
    expect(parseAmountSafe('1.5', 18)).toBe(1_500_000_000_000_000_000n);
  });

  it('returns 0n for an empty string', () => {
    expect(parseAmountSafe('', 18)).toBe(0n);
  });

  it('returns 0n instead of throwing for scientific notation', () => {
    expect(parseAmountSafe('1e5', 18)).toBe(0n);
  });

  it('returns 0n instead of throwing for other malformed input', () => {
    expect(parseAmountSafe('abc', 18)).toBe(0n);
    expect(parseAmountSafe('-1', 18)).toBe(0n);
  });
});

describe('applySlippage', () => {
  it('uses a wider auto default on the curve than on a graduated pool', () => {
    const curveResult = applySlippage(1_000_000n, 'auto', 'curve');
    const poolResult = applySlippage(1_000_000n, 'auto', 'pool');
    expect(curveResult).toBeLessThan(poolResult);
  });

  it('uses a custom slippage value when provided, regardless of venueKind', () => {
    // 500 bps = 5%
    expect(applySlippage(1_000_000n, 500, 'pool')).toBe(950_000n);
    expect(applySlippage(1_000_000n, 500, 'curve')).toBe(950_000n);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/amount.test.ts`
Expected: FAIL — `Cannot find module './amount'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/amount.ts
import { parseUnits } from 'viem';
import { resolveAutoSlippageBps } from './use-trade-settings';

// A plain decimal string only — rejects scientific notation ("1e5") and anything else
// viem's parseUnits would throw on. Callers run this during render (computing amountIn),
// so a throw here would crash the whole page, not just one trading panel.
export function parseAmountSafe(amount: string, decimals: number): bigint {
  if (amount === '' || !/^\d*\.?\d*$/.test(amount)) return 0n;
  try {
    return parseUnits(amount, decimals);
  } catch {
    return 0n;
  }
}

export function applySlippage(amount: bigint, slippageBps: number | 'auto', venueKind: 'curve' | 'pool'): bigint {
  const bps = slippageBps === 'auto' ? resolveAutoSlippageBps(venueKind) : slippageBps;
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/amount.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Update `buy-panel.tsx` to use the shared module**

In `fe/src/trading/buy-panel.tsx`:
- Remove the local `parseAmountSafe` function definition and its comment.
- Remove the local `applySlippage` function definition and its comment (including the now-outdated comment about "no venueKind parameter to thread through until a pool-swap follow-up plan actually needs one" — that follow-up plan is this one).
- Add `import { applySlippage, parseAmountSafe } from './amount';` and remove the now-unused `resolveAutoSlippageBps` import if `buy-panel.tsx` doesn't use it directly elsewhere (check — `useTradeSettings`'s `resolveAutoSlippageBps` re-export may still be imported elsewhere in the file for other reasons; only remove what's actually unused).
- Change every call site from `applySlippage(x, y)` to `applySlippage(x, y, 'curve')` (the extracted function now takes a third parameter).

- [ ] **Step 6: Update `sell-panel.tsx` the same way**

Same changes as Step 5, applied to `fe/src/trading/sell-panel.tsx`.

- [ ] **Step 7: Run the full existing Buy/Sell test suites to confirm zero behavior change**

Run: `cd fe && npx vitest run src/trading/buy-panel.test.tsx src/trading/sell-panel.test.tsx`
Expected: PASS, all tests unchanged in count and content (this is a pure refactor — if any existing test needed to change, something went wrong)

- [ ] **Step 8: Run tsc and eslint**

Run: `cd fe && npx tsc --noEmit && npx eslint src/trading`
Expected: both clean

- [ ] **Step 9: Commit**

```bash
cd fe && git add src/trading/amount.ts src/trading/amount.test.ts src/trading/buy-panel.tsx src/trading/sell-panel.tsx
git commit -m "refactor(fe): extract shared amount-parsing/slippage helpers out of Buy/Sell panels"
```

---

## Task 2: SwapRouter02 and V3 pool ABIs

**Files:**
- Create: `fe/src/trading/swapRouterAbi.ts`
- Create: `fe/src/trading/v3PoolAbi.ts`
- Test: not required — pure constant data, exercised indirectly by later tasks' hook tests (same convention as `curveAbi.ts`/`erc20Abi.ts` in the curve plan).

**Interfaces:**
- Produces: `swapRouterAbi` (viem `Abi`: `multicall`, `exactInputSingle`), `v3PoolAbi` (viem `Abi`: `fee`), `SWAP_ROUTER_ADDRESS: Address` (the confirmed router address, as a named export — config, not an inline string literal elsewhere, per the spec's "still open" item about treating router addresses as config).

- [ ] **Step 1: Write the ABI and address constant modules**

```typescript
// fe/src/trading/swapRouterAbi.ts
import { parseAbi } from 'viem';
import type { Address } from 'viem';

// Verified against a real on-chain transaction during
// docs/superpowers/specs/2026-10-06-v3-pool-swap-design.md's research: a direct call to this
// router with selector 0x5ae401dc (multicall) whose single inner call fully decoded as
// exactInputSingle with real, sane parameters (a real Pons-launched token swapped for this
// chain's WETH). This is also the exact address docs.ponsfamily.com names as "Swap Router" —
// independently corroborating it, despite an earlier spec deprioritizing it based on incomplete
// decoding (see that spec's "Rejected as a dependency" note, now superseded for this address).
export const SWAP_ROUTER_ADDRESS: Address = '0xcaf681a66d020601342297493863e78c959e5cb2';

export const swapRouterAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
```

```typescript
// fe/src/trading/v3PoolAbi.ts
import { parseAbi } from 'viem';

// A V3 pool's fee is immutable once the pool is created — this is the standard
// IUniswapV3PoolImmutables interface, not Robinhood-chain-specific.
export const v3PoolAbi = parseAbi([
  'function fee() view returns (uint24)',
]);
```

- [ ] **Step 2: Run the broader frontend typecheck to confirm these compile cleanly on their own**

Run: `cd fe && npx tsc --noEmit`
Expected: clean (these two new files aren't imported anywhere yet, so this just confirms they're syntactically/type valid in isolation)

- [ ] **Step 3: Commit**

```bash
cd fe && git add src/trading/swapRouterAbi.ts src/trading/v3PoolAbi.ts
git commit -m "feat(fe): add SwapRouter02 and V3 pool ABIs for V3 pool swap"
```

---

## Task 3: V3 pool fee hook

**Files:**
- Create: `fe/src/trading/use-pool-fee.ts`
- Test: `fe/src/trading/use-pool-fee.test.ts`

**Interfaces:**
- Consumes: `v3PoolAbi` (Task 2).
- Produces: `usePoolFee(poolAddress: Address | undefined): { fee: number | null; isLoading: boolean }`.

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/use-pool-fee.test.ts
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePoolFee } from './use-pool-fee';

const hooks = vi.hoisted(() => ({
  feeData: undefined as number | undefined,
  isLoading: false,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useReadContract: () => ({ data: hooks.feeData, isLoading: hooks.isLoading }),
}));

const pool = '0x4444444444444444444444444444444444444444' as const;

beforeEach(() => {
  hooks.feeData = undefined;
  hooks.isLoading = false;
});

describe('usePoolFee', () => {
  it('reports the real fee once resolved', () => {
    hooks.feeData = 10000;
    const { result } = renderHook(() => usePoolFee(pool));
    expect(result.current.fee).toBe(10000);
  });

  it('reports null, never a guessed fee, while unresolved', () => {
    hooks.feeData = undefined;
    hooks.isLoading = true;
    const { result } = renderHook(() => usePoolFee(pool));
    expect(result.current.fee).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-pool-fee.test.ts`
Expected: FAIL — `Cannot find module './use-pool-fee'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/use-pool-fee.ts
'use client';

import type { Address } from 'viem';
import { useReadContract } from 'wagmi';
import { v3PoolAbi } from './v3PoolAbi';

export interface PoolFee {
  fee: number | null;
  isLoading: boolean;
}

// A pool's fee tier is immutable, but this app never guesses it (a wrong fee targets a
// different pool entirely, or reverts) — see this plan's Review Focus.
export function usePoolFee(poolAddress: Address | undefined): PoolFee {
  const { data, isLoading } = useReadContract({
    address: poolAddress,
    abi: v3PoolAbi,
    functionName: 'fee',
    query: { enabled: Boolean(poolAddress) },
  });

  return { fee: data ?? null, isLoading };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/use-pool-fee.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/use-pool-fee.ts src/trading/use-pool-fee.test.ts
git commit -m "feat(fe): add V3 pool fee hook, read directly on-chain"
```

---

## Task 4: Swap quote hook

**Files:**
- Create: `fe/src/trading/use-swap-quote.ts`
- Test: `fe/src/trading/use-swap-quote.test.ts`

**Interfaces:**
- Consumes: `swapRouterAbi`, `SWAP_ROUTER_ADDRESS` (Task 2), `decodeTradeError` (existing, `fe/src/trading/decodeTradeError.ts`).
- Produces: `useSwapQuote(params: { tokenIn: Address | undefined; tokenOut: Address | undefined; fee: number | null; amountIn: bigint; recipient: Address | undefined }): { outputAmount: bigint | null; isLoading: boolean; errorMessage: string | null }`.

Unlike the curve's `useCurveQuote` (which needed two unconditional hook calls to avoid a Rules-of-Hooks violation when branching on buy-vs-sell direction — see Global Constraints), this hook has no such branching: `exactInputSingle` is the same function call regardless of swap direction, only its `tokenIn`/`tokenOut` arguments change. One `useSimulateContract` call, always.

The quote reads `exactInputSingle` directly on the router (not wrapped in `multicall`) — `multicall` only matters for the real submission's deadline enforcement (Task 5); it has no effect on the simulated output amount, and simulating the bare call is simpler to decode (`useSimulateContract`'s typed `data.result` directly, no manual `decodeFunctionResult` on a nested `bytes[]` needed).

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/use-swap-quote.test.ts
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSwapQuote } from './use-swap-quote';

const hooks = vi.hoisted(() => ({
  data: undefined as { result: bigint } | undefined,
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
const recipient = '0x5555555555555555555555555555555555555555' as const;

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useSwapQuote', () => {
  it('returns the simulated output amount', () => {
    hooks.data = { result: 500000n };
    const { result } = renderHook(() =>
      useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1000000n, recipient }),
    );
    expect(result.current.outputAmount).toBe(500000n);
  });

  it('disables the simulation for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 0n, recipient }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('disables the simulation while the pool fee has not resolved yet', () => {
    renderHook(() => useSwapQuote({ tokenIn, tokenOut, fee: null, amountIn: 1000000n, recipient }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('passes amountOutMinimum: 0 for the quote read — the real minimum is only applied on submission', () => {
    renderHook(() => useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1000000n, recipient }));
    const args = hooks.simulateArgs as { args: [{ tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }] };
    expect(args.args[0]).toEqual({
      tokenIn, tokenOut, fee: 10000, recipient, amountIn: 1000000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('pool does not exist');
    const { result } = renderHook(() =>
      useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1000000n, recipient }),
    );
    expect(result.current.errorMessage).toBe('pool does not exist');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-swap-quote.test.ts`
Expected: FAIL — `Cannot find module './use-swap-quote'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/use-swap-quote.ts
'use client';

import type { Address } from 'viem';
import { useSimulateContract } from 'wagmi';
import { swapRouterAbi, SWAP_ROUTER_ADDRESS } from './swapRouterAbi';
import { decodeTradeError } from './decodeTradeError';

export interface SwapQuoteParams {
  tokenIn: Address | undefined;
  tokenOut: Address | undefined;
  fee: number | null;
  amountIn: bigint;
  recipient: Address | undefined;
}

export interface SwapQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

export function useSwapQuote({ tokenIn, tokenOut, fee, amountIn, recipient }: SwapQuoteParams): SwapQuoteResult {
  const enabled = Boolean(tokenIn && tokenOut && fee !== null && recipient && amountIn > 0n);
  const { data, isLoading, error } = useSimulateContract({
    address: SWAP_ROUTER_ADDRESS,
    abi: swapRouterAbi,
    functionName: 'exactInputSingle',
    args: enabled ? [{
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      fee: fee as number,
      recipient: recipient as Address,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }] : undefined,
    query: { enabled },
  });

  return {
    outputAmount: data?.result ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/use-swap-quote.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Run tsc and eslint**

Run: `cd fe && npx tsc --noEmit && npx eslint src/trading`
Expected: both clean (this hook has no direction-branching, so it should not hit the Rules-of-Hooks issue the curve plan's equivalent hook did — confirm with eslint, don't just assume)

- [ ] **Step 6: Commit**

```bash
cd fe && git add src/trading/use-swap-quote.ts src/trading/use-swap-quote.test.ts
git commit -m "feat(fe): add V3 swap quote hook via eth_call simulation"
```

---

## Task 5: Swap panel

**Files:**
- Create: `fe/src/trading/swap-panel.tsx`
- Test: `fe/src/trading/swap-panel.test.tsx`

**Interfaces:**
- Consumes: `useSwapQuote` (Task 4), `usePoolFee` (Task 3), `swapRouterAbi`/`SWAP_ROUTER_ADDRESS` (Task 2), `parseAmountSafe`/`applySlippage` (Task 1), `useTokenAllowance`, `useTradeSettings`, `TradeSettingsPopover`, `useTradeSubmission`, `TradeStatus` (all existing, unchanged, from the curve plan).
- Produces: `<SwapPanel poolAddress={Address} tokenA={{ address: Address; symbol: string | null; decimals: number }} tokenB={{ address: Address; symbol: string | null; decimals: number }} explorerBase={string | null} />`.

Unlike `BuyPanel`/`SellPanel` (two components, one direction each), this is one component with an internal `direction: 'aToB' | 'bToA'` toggle — `exactInputSingle` only needs `tokenIn`/`tokenOut` swapped, not a different function.

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/swap-panel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwapPanel } from './swap-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  allowance: 0n,
  balanceA: 10000000000000000000n,
  balanceB: 10000000000000000000n,
  poolFee: 10000 as number | undefined,
  simulateData: undefined as { result: bigint } | undefined,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: (args: { functionName: string; address: string }) => {
    // `balanceOf` and `allowance` reads can both target the same ERC20 contract address (whichever
    // side is currently the input token) — discriminate on functionName first, not address alone,
    // or an allowance check would silently read back a balance value instead.
    if (args.functionName === 'fee') return { data: hooks.poolFee, isLoading: false };
    if (args.functionName === 'allowance') return { data: hooks.allowance, isFetching: false, refetch: vi.fn() };
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
}));

const poolAddress = '0x4444444444444444444444444444444444444444' as const;
const tokenA = { address: '0x1111111111111111111111111111111111111112' as const, symbol: 'LAUNCH', decimals: 18 };
const tokenB = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'WETH', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.allowance = 2000000000000000000n;
  hooks.balanceA = 10000000000000000000n;
  hooks.balanceB = 10000000000000000000n;
  hooks.poolFee = 10000;
  hooks.simulateData = undefined;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('SwapPanel', () => {
  it('defaults to swapping tokenA for tokenB', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByText(new RegExp(`Sell.*${tokenA.symbol}`, 'i'))).toBeInTheDocument();
  });

  it('flips direction when the toggle is clicked', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    expect(screen.getByText(new RegExp(`Sell.*${tokenB.symbol}`, 'i'))).toBeInTheDocument();
  });

  it('re-targets the balance/allowance checks to the new input side after flipping, not left pointed at the original side', () => {
    // tokenA has plenty of balance; tokenB (the input side once flipped) does not. If the balance
    // check were still hardcoded to tokenA after the flip, this would wrongly leave Swap enabled.
    hooks.balanceA = 10000000000000000000n;
    hooks.balanceB = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('disables Swap when the amount is empty', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('shows Approve instead of Swap when allowance does not cover the amount', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('submits the swap wrapped in multicall with a real deadline, once the quote resolves', () => {
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'multicall', args: expect.arrayContaining([expect.any(BigInt)]) }),
      expect.anything(),
    );
  });

  it('disables Swap and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });

  it('disables Swap when the input-side balance is insufficient', () => {
    hooks.balanceA = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash and leaves Swap disabled when the amount contains scientific notation', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/swap-panel.test.tsx`
Expected: FAIL — `Cannot find module './swap-panel'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/swap-panel.tsx
'use client';

import { useState } from 'react';
import { type Address, encodeFunctionData, formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { swapRouterAbi, SWAP_ROUTER_ADDRESS } from './swapRouterAbi';
import { usePoolFee } from './use-pool-fee';
import { useSwapQuote } from './use-swap-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { TradeStatus } from './trade-status';
import { applySlippage, parseAmountSafe } from './amount';

export interface SwapToken {
  address: Address;
  symbol: string | null;
  decimals: number;
}

export interface SwapPanelProps {
  poolAddress: Address;
  tokenA: SwapToken;
  tokenB: SwapToken;
  explorerBase: string | null;
}

export function SwapPanel({ poolAddress, tokenA, tokenB, explorerBase }: SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;
  const { fee } = usePoolFee(poolAddress);

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const amountIn = parseAmountSafe(amount, tokenIn.decimals);

  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });
  const allowance = useTokenAllowance(tokenIn.address, SWAP_ROUTER_ADDRESS);
  const quote = useSwapQuote({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee, amountIn, recipient: account });
  const submission = useTradeSubmission();
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = (tokenInBalance ?? 0n) < amountIn;
  const needsApproval = amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  function submitSwap() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const amountOutMinimum = applySlippage(quote.outputAmount, settings.slippageBps, 'pool');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + settings.deadlineMinutes * 60);
    const innerCalldata = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: fee as number,
        recipient: account,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      }],
    });
    submission.submit(
      { address: SWAP_ROUTER_ADDRESS, abi: swapRouterAbi, functionName: 'multicall', args: [deadline, [innerCalldata]] },
      { onSuccess: () => setAmount('') },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-sm">
          Sell {tokenIn.symbol ?? '—'}
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="pool" />
      </div>
      <Button type="button" variant="ghost" size="sm" aria-label="Flip swap direction"
        onClick={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); setAmount(''); }}>
        ⇅
      </Button>
      {quote.outputAmount !== null ? (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, tokenOut.decimals)} {tokenOut.symbol ?? ''}</p>
      ) : amountIn > 0n && quote.errorMessage ? (
        <p className="text-sm text-muted-foreground">Quote unavailable: {quote.errorMessage}</p>
      ) : null}
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {!isWrongChain && amountIn > 0n && hasInsufficientBalance && (
        <p className="text-sm text-destructive">Insufficient {tokenIn.symbol ?? 'token'} balance.</p>
      )}
      {allowance.approveError && (
        <p role="alert" className="text-sm text-destructive">
          {allowance.approveError}
        </p>
      )}
      {needsApproval ? (
        <Button
          type="button"
          disabled={allowance.isApproving || allowance.isConfirmingApproval || isWrongChain}
          onClick={() => allowance.approve(amountIn)}
        >
          {allowance.isApproving ? 'Approving…' : allowance.isConfirmingApproval ? 'Confirming approval…' : 'Approve'}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain || quote.outputAmount === null || isSubmitting}
          onClick={submitSwap}
        >
          Swap
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/swap-panel.test.tsx`
Expected: PASS, 10 tests

- [ ] **Step 5: Run tsc and eslint**

Run: `cd fe && npx tsc --noEmit && npx eslint src/trading`
Expected: both clean

- [ ] **Step 6: Commit**

```bash
cd fe && git add src/trading/swap-panel.tsx src/trading/swap-panel.test.tsx
git commit -m "feat(fe): add V3 pool Swap panel with direction toggle"
```

---

## Task 6: Wire into the launch detail page

**Files:**
- Modify: `fe/src/features/launch/launch-detail.tsx`
- Modify: `fe/src/features/launch/launch-detail.test.tsx`

**Interfaces:**
- Consumes: `SwapPanel` (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `fe/src/features/launch/launch-detail.test.tsx` (the file already has a `vi.mock('wagmi', ...)` block from the curve-trading plan's Task 9 — extend it, don't duplicate; add `useReadContract`'s `fee`-functionName branch the same way `swap-panel.test.tsx` does, or verify the existing mock's `useReadContract` already handles an unrecognized `functionName` gracefully by falling through to a default — check before assuming):

```typescript
it('shows the V3 swap panel for a V1 launch whose V3 pool venue is currently active', () => {
  render(
    <LaunchDetail
      detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: null })] })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.getByRole('button', { name: /flip|swap direction/i })).toBeInTheDocument();
});

it('hides the V3 swap panel once that venue is no longer active', () => {
  render(
    <LaunchDetail
      detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: '500' })] })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
});

it('hides the V3 swap panel when tokenDecimals has not resolved yet, rather than guessing it', () => {
  render(
    <LaunchDetail
      detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: null })], tokenDecimals: null })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
});

it('hides the V3 swap panel when the quote asset decimals has not resolved yet, rather than guessing it', () => {
  render(
    <LaunchDetail
      detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: null })], quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: null } })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: FAIL — no swap-direction button rendered yet

- [ ] **Step 3: Wire `SwapPanel` into `launch-detail.tsx`**

Add the import:

```typescript
import { SwapPanel } from '@/trading/swap-panel';
```

Alongside the existing `activeCurveVenue` constant, add:

```typescript
const activeV3Venue = detail.officialVenues.find((venue) => venue.kind === 'v3_pool' && venue.effectiveToBlock === null);
```

Note this deliberately has no `lifecycleStatus` condition — unlike the curve gate, a V1 launch's V3 pool is its venue from launch with no curve-to-pool transition to distinguish (confirmed against real data during this plan's research: every `lifecycleStatus` value a V1 launch can have — `'trading'` or `'graduated'` — maps to exactly one active `v3_pool` venue; copying the curve gate's `lifecycleStatus === 'trading'` condition here would be wrong, not just redundant).

In the same place the curve panel is conditionally rendered, add the V3 case:

```tsx
{activeV3Venue && detail.tokenDecimals !== null && detail.quoteAsset.decimals !== null && (
  <div className="mt-4 border-t border-border pt-4">
    <SwapPanel
      poolAddress={activeV3Venue.ref as `0x${string}`}
      tokenA={{ address: detail.tokenAddress as `0x${string}`, symbol: displaySymbol(detail.symbol), decimals: detail.tokenDecimals }}
      tokenB={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals }}
      explorerBase={explorerBase ?? null}
    />
  </div>
)}
```

(`displaySymbol` is already imported in this file from `@/api/format`, used elsewhere for the header — reuse it rather than passing `detail.symbol` raw.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: PASS, including the four new tests

- [ ] **Step 5: Run the full FE suite, typecheck, and lint**

Run: `cd fe && npx vitest run && npx tsc --noEmit && npx eslint src`
Expected: all pass, no new errors

- [ ] **Step 6: Commit**

```bash
cd fe && git add src/trading/swap-panel.tsx src/features/launch/launch-detail.tsx src/features/launch/launch-detail.test.tsx
git commit -m "feat(fe): wire V3 pool Swap panel into the launch detail page"
```

---

## Not in this plan (follow-up work)

- Pools-tab Swap panel (any arbitrary V3 pool) — needs a backend addition first (`currency0Decimals`/`currency1Decimals` on the Pool API, confirmed missing during this plan's research) plus a direction-toggle UI generalized beyond "the launch's own token vs. its quote asset."
- V4 pool swap (Universal Router command/action encoding) — separate, larger research+implementation effort per the spec's own phasing.
- Cross-checking the router address against a second independent source beyond the real-transaction decode + Pons's own docs naming it (already stronger evidence than the curve plan had for its own router-adjacent open items at the time it shipped).
