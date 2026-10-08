# Unified Swap Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Uniswap-style swap panel (Sell/Buy cards, flip arrow, both inputs editable and two-way quoted) used by the bonding curve, V3 and V4 trading venues.

**Architecture:** A presentational `TradeCard` + `SwapShell` replace the hand-rolled markup of the three panels. A shared `useSwapAmounts` hook holds "which side the user typed in" and, when that is the Buy side, derives the exact-input amount `X` via a reverse quote (`solveInputForOutput` over simulations; V3 uses its exact-out quoter in one call). Execution on every venue stays exact-input using `X`, so Permit2/approval/batching/slippage code is untouched. `BuyPanel`+`SellPanel`+`CurveTradePanel` merge into `CurveSwapPanel`.

**Tech Stack:** Next.js (see `fe/AGENTS.md` — this Next has breaking changes; none of this plan touches routing/config), React, wagmi + viem, Tailwind, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-unified-swap-panel-design.md`

## Global Constraints

- Frontend only (`fe/`). No backend change, no migration, no change to any on-chain call shape, approval amount, quote, slippage, deadline or EIP-5792 batching behavior.
- Frontend copy is English. Code identifiers, tests, comments and filenames are English.
- `null` means unavailable, never zero: a `$` line is hidden (not `$0`) when no real USD price exists; an unsolvable reverse quote shows "Quote unavailable" and disables the action button — it never guesses.
- No `Limit` tab and no `Buy | Sell` tab bar anywhere in this work.
- The venue (curve vs. V3/V4 pool) stays visible as a badge on the panel.
- Slippage and deadline are edited only in the existing settings popover (as on Uniswap); the panel face shows just a read-only "Min received" row computed with the same `applySlippage` the submit path uses.
- Light/dark: use existing theme tokens (`bg-card`, `bg-muted`, `text-muted-foreground`, `bg-primary`, …); introduce no new color.
- Work directly on `main`. Run commands from `fe/` unless stated. Commit only the files a task lists (the working tree has many unrelated uncommitted changes — never `git add -A`).
- Every commit message ends with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

Inputs/conditions the spec implies that a user will plausibly hit; each has a pinned test in the owning task:

1. Typing a Buy amount larger than the pool/curve can deliver → Sell card shows "Quote unavailable", button disabled, no crash (Task 1, Task 3, Task 7).
2. Typing fast in the Buy box → earlier searches are aborted, only the last value's result is applied (Task 3).
3. Flipping after typing keeps the typed number on the same token and never shows a stale derived value from the old direction (Task 5, Task 6).
4. Clearing the box or typing `.`/`1e5`/garbage → no RPC calls, no crash, button says "Enter an amount" (Task 3, Task 5).
5. Wallet disconnected → reverse quote unavailable (not an error), forward behavior unchanged (Task 3, Task 8).
6. ERC20-quoted curve buy / any curve sell reverts in simulation until the curve is approved (existing forward-quote behavior) → reverse search returns unavailable rather than hanging (Task 1, Task 3; verified live in Task 10).

---

### Task 1: `solveInputForOutput` (pure reverse-quote search)

**Files:**
- Create: `fe/src/trading/solve-input-for-output.ts`
- Test: `fe/src/trading/solve-input-for-output.test.ts`

**Interfaces:**
- Produces:
  - `type QuoteFn = (amountIn: bigint, signal: AbortSignal) => Promise<bigint | null>` — exact-input quote; `null` = the simulation failed/reverted (treated as "too large").
  - `solveInputForOutput(quoteFn: QuoteFn, targetOut: bigint, options?: { signal?: AbortSignal; maxCalls?: number; initialGuess?: bigint }): Promise<bigint | null>` — smallest-found `X` with `quoteFn(X) >= targetOut`, within 0.01% (or 1 raw unit); `null` if none found, the call cap is hit, `targetOut <= 0n`, or `signal` aborts.
  - `SOLVER_MAX_CALLS = 40` (exported constant).

- [ ] **Step 1: Write the failing tests**

```ts
// fe/src/trading/solve-input-for-output.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SOLVER_MAX_CALLS, solveInputForOutput, type QuoteFn } from './solve-input-for-output';

const never = new AbortController().signal;

// out = in * 3 (linear, like a flat-price pool)
const linear: QuoteFn = async (x) => x * 3n;
// out = x^2 / 1e18, convex like a curve (a given input buys proportionally more as size grows)
const convex: QuoteFn = async (x) => (x * x) / 10n ** 18n;
// reverts above a capacity, like a pool/curve that cannot deliver more
const capped = (capacity: bigint): QuoteFn => async (x) => (x > capacity ? null : x * 3n);

describe('solveInputForOutput', () => {
  it('finds an input whose quote covers the target on a linear quote, with <=0.01% overshoot', async () => {
    const target = 3_000_000_000_000_000_000n; // needs ~1e18 in
    const x = await solveInputForOutput(linear, target);
    expect(x).not.toBeNull();
    expect(await linear(x!, never)).toBeGreaterThanOrEqual(target);
    expect(x!).toBeLessThanOrEqual((10n ** 18n * 10_001n) / 10_000n);
  });

  it('works on a convex (curve-like) quote', async () => {
    const target = 4n * 10n ** 18n; // x^2/1e18 = 4e18 -> x = 2e18
    const x = await solveInputForOutput(convex, target);
    expect(await convex(x!, never)).toBeGreaterThanOrEqual(target);
    expect(x!).toBeLessThanOrEqual((2n * 10n ** 18n * 10_001n) / 10_000n);
  });

  it('works for a tiny target (1 raw unit)', async () => {
    const x = await solveInputForOutput(linear, 1n);
    expect(await linear(x!, never)).toBeGreaterThanOrEqual(1n);
    expect(x!).toBeLessThanOrEqual(1n);
  });

  it('treats a null quote above capacity as "too large" and still solves a reachable target', async () => {
    const quote = capped(5n * 10n ** 18n);
    const target = 3n * 4n * 10n ** 18n; // needs 4e18, under the 5e18 capacity
    const x = await solveInputForOutput(quote, target);
    expect(x).not.toBeNull();
    expect(await quote(x!, never)).toBeGreaterThanOrEqual(target);
  });

  it('returns null when the target exceeds capacity', async () => {
    const quote = capped(5n * 10n ** 18n);
    expect(await solveInputForOutput(quote, 3n * 6n * 10n ** 18n)).toBeNull();
  });

  it('returns null when the quote function always fails', async () => {
    expect(await solveInputForOutput(async () => null, 1000n)).toBeNull();
  });

  it('returns null for a zero or negative target without calling the quote function', async () => {
    const fn = vi.fn<QuoteFn>(async (x) => x);
    expect(await solveInputForOutput(fn, 0n)).toBeNull();
    expect(await solveInputForOutput(fn, -5n)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('never exceeds the call cap', async () => {
    const fn = vi.fn<QuoteFn>(async (x) => x * 3n);
    await solveInputForOutput(fn, 10n ** 30n);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(SOLVER_MAX_CALLS);
  });

  it('returns null when the cap is hit before converging', async () => {
    // A quote that is always just under the target never converges.
    const x = await solveInputForOutput(async () => 1n, 2n, { maxCalls: 5 });
    expect(x).toBeNull();
  });

  it('stops and returns null when the signal aborts', async () => {
    const controller = new AbortController();
    const fn = vi.fn<QuoteFn>(async (x) => {
      controller.abort();
      return x * 3n;
    });
    const x = await solveInputForOutput(fn, 3n * 10n ** 18n, { signal: controller.signal });
    expect(x).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('treats a quote function that throws as unavailable', async () => {
    const x = await solveInputForOutput(async () => { throw new Error('rpc down'); }, 1000n);
    expect(x).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/trading/solve-input-for-output.test.ts`
Expected: FAIL — cannot resolve `./solve-input-for-output`.

- [ ] **Step 3: Implement**

```ts
// fe/src/trading/solve-input-for-output.ts

// Exact-input quote: how much comes out for `amountIn` going in. `null` means the simulation
// failed (revert / over capacity / RPC error) — the solver reads that as "this input is too large".
export type QuoteFn = (amountIn: bigint, signal: AbortSignal) => Promise<bigint | null>;

export const SOLVER_MAX_CALLS = 40;
const GROWTH_FACTOR = 4n;
// 2^128: far above any real token amount; stops an unreachable target from growing forever.
const MAX_INPUT = 1n << 128n;
const DEFAULT_GUESS = 1_000_000n;

export interface SolveOptions {
  signal?: AbortSignal;
  maxCalls?: number;
  initialGuess?: bigint;
}

// Inverts a monotonic exact-input quote: finds (approximately) the smallest `X` for which
// quoteFn(X) >= targetOut, so a swap executed as exact-input with X yields at least targetOut
// before slippage. Execution never changes — this only derives X for the Sell card when the
// user typed in the Buy card. Returns null (never a guess) when no X is found.
export async function solveInputForOutput(
  quoteFn: QuoteFn,
  targetOut: bigint,
  options: SolveOptions = {},
): Promise<bigint | null> {
  if (targetOut <= 0n) return null;
  const maxCalls = options.maxCalls ?? SOLVER_MAX_CALLS;
  const outer = options.signal ?? new AbortController().signal;
  let calls = 0;

  async function quote(x: bigint): Promise<bigint | null | 'stop'> {
    if (outer.aborted || calls >= maxCalls) return 'stop';
    calls += 1;
    try {
      return await quoteFn(x, outer);
    } catch {
      return null;
    }
  }

  // Phase 1: bracket. lo = largest input known too small, hi = smallest input known enough/too large.
  let lo = 0n;
  let hi = options.initialGuess && options.initialGuess > 0n ? options.initialGuess : DEFAULT_GUESS;
  let best: bigint | null = null;
  for (;;) {
    const q = await quote(hi);
    if (q === 'stop') return null;
    if (q === null) break; // too large (or failed): answer, if any, lies in (lo, hi)
    if (q >= targetOut) { best = hi; break; }
    lo = hi;
    hi *= GROWTH_FACTOR;
    if (hi > MAX_INPUT) return null;
  }

  // Phase 2: bisect until the bracket is within 0.01% of hi (or 1 raw unit).
  for (;;) {
    const width = hi - lo;
    const tolerance = hi / 10_000n > 1n ? hi / 10_000n : 1n;
    if (width <= tolerance) break;
    const mid = lo + width / 2n;
    const q = await quote(mid);
    if (q === 'stop') return null;
    if (q !== null && q >= targetOut) { best = mid; hi = mid; } else if (q === null) { hi = mid; } else { lo = mid; }
  }
  return best;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/trading/solve-input-for-output.test.ts`
Expected: PASS (10 tests). If the "tiny target" test fails because `DEFAULT_GUESS` (1e6) is far above the answer, that is a real bug: phase 2 must still bisect down from `hi`, which it does (`lo = 0`); debug rather than weakening the test.

- [ ] **Step 5: Commit**

```bash
git add src/trading/solve-input-for-output.ts src/trading/solve-input-for-output.test.ts
git commit -m "feat: add reverse-quote solver for the two-way swap panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Per-venue reverse quote builders

**Files:**
- Create: `fe/src/trading/reverse-quote.ts`
- Test: `fe/src/trading/reverse-quote.test.ts`
- Modify: `fe/src/trading/v3QuoterAbi.ts` (add `quoteExactOutputSingle`)

**Interfaces:**
- Consumes: `QuoteFn`, `solveInputForOutput` (Task 1); `curveTradeAbi` (`./curveAbi`); `v3QuoterAbi`, `V3_QUOTER_ADDRESS`; `v4QuoterAbi`, `V4_QUOTER_ADDRESS`; `V4PoolKey` from `./v4SwapEncoding`.
- Produces:
  - `type ReverseSolve = (targetOut: bigint, signal: AbortSignal) => Promise<bigint | null>`
  - `type SimulateClient = { simulateContract: (args: any) => Promise<{ result: unknown }> }` (structural; wagmi's `usePublicClient()` result satisfies it)
  - `makeCurveReverseSolve(client, { curveAddress, direction: 'buy' | 'sell', account, isNativeQuote }): ReverseSolve`
  - `makeV3ReverseSolve(client, { tokenIn, tokenOut, fee }): ReverseSolve` — single `quoteExactOutputSingle` call
  - `makeV4ReverseSolve(client, { poolKey, zeroForOne }): ReverseSolve` — search over `quoteExactInputSingleV4`

- [ ] **Step 1: Add the V3 exact-out ABI entry**

In `fe/src/trading/v3QuoterAbi.ts`, extend `parseAbi` (verified live on chain 4663 on 2026-10-09 — see the spec's "Two-way quoting"):

```ts
export const v3QuoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
```

- [ ] **Step 2: Write the failing tests**

```ts
// fe/src/trading/reverse-quote.test.ts
import { describe, expect, it, vi } from 'vitest';
import { curveTradeAbi } from './curveAbi';
import { V3_QUOTER_ADDRESS } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS } from './v4QuoterAbi';
import { makeCurveReverseSolve, makeV3ReverseSolve, makeV4ReverseSolve } from './reverse-quote';

const signal = new AbortController().signal;
const account = '0x1111111111111111111111111111111111111111' as const;
const curve = '0x4444444444444444444444444444444444444444' as const;
const tokenIn = '0x2222222222222222222222222222222222222222' as const;
const tokenOut = '0x3333333333333333333333333333333333333333' as const;
const poolKey = { currency0: tokenIn, currency1: tokenOut, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' as const };

describe('makeV3ReverseSolve', () => {
  it('derives the input with ONE quoteExactOutputSingle call', async () => {
    const simulateContract = vi.fn(async () => ({ result: [143_432_958n, 0n, 1, 86_825n] }));
    const solve = makeV3ReverseSolve({ simulateContract }, { tokenIn, tokenOut, fee: 10000 });
    expect(await solve(1_000_000_000_000n, signal)).toBe(143_432_958n);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      address: V3_QUOTER_ADDRESS,
      functionName: 'quoteExactOutputSingle',
      args: [{ tokenIn, tokenOut, amount: 1_000_000_000_000n, fee: 10000, sqrtPriceLimitX96: 0n }],
    }));
  });

  it('returns null when the quoter reverts', async () => {
    const solve = makeV3ReverseSolve({ simulateContract: vi.fn(async () => { throw new Error('revert'); }) }, { tokenIn, tokenOut, fee: 10000 });
    expect(await solve(1n, signal)).toBeNull();
  });
});

describe('makeV4ReverseSolve', () => {
  it('searches over quoteExactInputSingleV4 and returns an input that covers the target', async () => {
    // linear 2x quote
    const simulateContract = vi.fn(async (args: { args: [{ exactAmount: bigint }] }) => ({ result: [args.args[0].exactAmount * 2n, 0n] }));
    const solve = makeV4ReverseSolve({ simulateContract }, { poolKey, zeroForOne: true });
    const x = await solve(2_000_000n, signal);
    expect(x).not.toBeNull();
    expect(x! * 2n).toBeGreaterThanOrEqual(2_000_000n);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      address: V4_QUOTER_ADDRESS,
      functionName: 'quoteExactInputSingleV4',
    }));
  });

  it('returns null when every simulation reverts', async () => {
    const solve = makeV4ReverseSolve({ simulateContract: vi.fn(async () => { throw new Error('revert'); }) }, { poolKey, zeroForOne: true });
    expect(await solve(1000n, signal)).toBeNull();
  });
});

describe('makeCurveReverseSolve', () => {
  it('buy on a native-ETH curve simulates buy() with value = the candidate input', async () => {
    const simulateContract = vi.fn(async (args: { args: [bigint, bigint, string] }) => ({ result: args.args[0] * 10n }));
    const solve = makeCurveReverseSolve({ simulateContract }, { curveAddress: curve, direction: 'buy', account, isNativeQuote: true });
    const x = await solve(10_000n, signal);
    expect(x! * 10n).toBeGreaterThanOrEqual(10_000n);
    const call = simulateContract.mock.calls[0][0] as { address: string; abi: unknown; functionName: string; account: string; value: bigint; args: [bigint, bigint, string] };
    expect(call).toMatchObject({ address: curve, abi: curveTradeAbi, functionName: 'buy', account });
    expect(call.value).toBe(call.args[0]);
    expect(call.args[1]).toBe(0n);
    expect(call.args[2]).toBe(account);
  });

  it('buy on an ERC20-quoted curve sends no value', async () => {
    const simulateContract = vi.fn(async (args: { args: [bigint] }) => ({ result: args.args[0] * 10n }));
    const solve = makeCurveReverseSolve({ simulateContract }, { curveAddress: curve, direction: 'buy', account, isNativeQuote: false });
    await solve(10_000n, signal);
    expect((simulateContract.mock.calls[0][0] as { value?: bigint }).value).toBeUndefined();
  });

  it('sell simulates sell()', async () => {
    const simulateContract = vi.fn(async (args: { args: [bigint] }) => ({ result: args.args[0] / 2n }));
    const solve = makeCurveReverseSolve({ simulateContract }, { curveAddress: curve, direction: 'sell', account, isNativeQuote: true });
    const x = await solve(1_000n, signal);
    expect(x! / 2n).toBeGreaterThanOrEqual(1_000n);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'sell' }));
  });

  it('returns null (unavailable) when the simulation reverts, e.g. missing approval', async () => {
    const solve = makeCurveReverseSolve({ simulateContract: vi.fn(async () => { throw new Error('insufficient allowance'); }) }, { curveAddress: curve, direction: 'sell', account, isNativeQuote: false });
    expect(await solve(1000n, signal)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/trading/reverse-quote.test.ts`
Expected: FAIL — cannot resolve `./reverse-quote`.

- [ ] **Step 4: Implement**

```ts
// fe/src/trading/reverse-quote.ts
import type { Address } from 'viem';
import { curveTradeAbi } from './curveAbi';
import { solveInputForOutput, type QuoteFn } from './solve-input-for-output';
import { V3_QUOTER_ADDRESS, v3QuoterAbi } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS, v4QuoterAbi } from './v4QuoterAbi';
import type { V4PoolKey } from './v4SwapEncoding';

// "Given the amount I want to receive, what exact-input amount do I need to send?" — one function
// per venue. Execution is always exact-input with the returned amount; see the spec's
// "Two-way quoting". null = no answer (revert / over capacity / RPC error) — never a guess.
export type ReverseSolve = (targetOut: bigint, signal: AbortSignal) => Promise<bigint | null>;

// Structural so tests can pass a plain fake; wagmi's usePublicClient() result satisfies it.
export interface SimulateClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's generic simulateContract typing is not worth reproducing for a structural test seam
  simulateContract: (args: any) => Promise<{ result: unknown }>;
}

// V3: the deployed QuoterV2 has a real exact-output quote (verified live on chain 4663), so this
// is a single call and no search.
export function makeV3ReverseSolve(
  client: SimulateClient,
  { tokenIn, tokenOut, fee }: { tokenIn: Address; tokenOut: Address; fee: number },
): ReverseSolve {
  return async (targetOut) => {
    try {
      const { result } = await client.simulateContract({
        address: V3_QUOTER_ADDRESS,
        abi: v3QuoterAbi,
        functionName: 'quoteExactOutputSingle',
        args: [{ tokenIn, tokenOut, amount: targetOut, fee, sqrtPriceLimitX96: 0n }],
      });
      return (result as readonly [bigint, ...unknown[]])[0];
    } catch {
      return null;
    }
  };
}

// V4: the deployed quoter exposes only exact-input (quoteExactInputSingleV4), so invert it.
export function makeV4ReverseSolve(
  client: SimulateClient,
  { poolKey, zeroForOne }: { poolKey: V4PoolKey; zeroForOne: boolean },
): ReverseSolve {
  const quote: QuoteFn = async (amountIn) => {
    try {
      const { result } = await client.simulateContract({
        address: V4_QUOTER_ADDRESS,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingleV4',
        args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
      });
      return (result as readonly [bigint, bigint])[0];
    } catch {
      return null;
    }
  };
  return (targetOut, signal) => solveInputForOutput(quote, targetOut, { signal });
}

// Curve: no quote or exact-output view exists, so invert the real buy()/sell() simulation — it
// already includes every fee and the time/address-dependent snipe tax. The simulation runs as the
// connected account, so an ERC20-quoted buy (and any sell) can revert until the curve is
// approved — that surfaces here as null ("Quote unavailable"), same as the forward quote today.
export function makeCurveReverseSolve(
  client: SimulateClient,
  { curveAddress, direction, account, isNativeQuote }: { curveAddress: Address; direction: 'buy' | 'sell'; account: Address; isNativeQuote: boolean },
): ReverseSolve {
  const quote: QuoteFn = async (amountIn) => {
    try {
      const { result } = await client.simulateContract({
        address: curveAddress,
        abi: curveTradeAbi,
        functionName: direction,
        args: [amountIn, 0n, account],
        account,
        value: direction === 'buy' && isNativeQuote ? amountIn : undefined,
      });
      return result as bigint;
    } catch {
      return null;
    }
  };
  return (targetOut, signal) => solveInputForOutput(quote, targetOut, { signal });
}
```

- [ ] **Step 5: Run to verify pass, typecheck**

Run: `npx vitest run src/trading/reverse-quote.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/trading/reverse-quote.ts src/trading/reverse-quote.test.ts src/trading/v3QuoterAbi.ts
git commit -m "feat: add per-venue reverse quote builders (V3 exact-out, V4/curve search)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `useReverseQuote` (debounced, abortable) and `useSwapAmounts`

**Files:**
- Create: `fe/src/trading/use-reverse-quote.ts`, `fe/src/trading/use-swap-amounts.ts`
- Test: `fe/src/trading/use-reverse-quote.test.ts`, `fe/src/trading/use-swap-amounts.test.ts`

**Interfaces:**
- Consumes: `ReverseSolve` (Task 2); `parseAmountSafe`, from `./amount`.
- Produces:
  - `REVERSE_QUOTE_DEBOUNCE_MS = 300`
  - `useReverseQuote({ targetOut: bigint; solve: ReverseSolve | null; solveKey: string }): { amountIn: bigint | null; status: 'idle' | 'loading' | 'ok' | 'unavailable' }` — `idle` when `targetOut === 0n` or `solve === null`... (`solve === null` with a positive target → `'unavailable'`). Re-runs when `targetOut` or `solveKey` change; aborts the previous search; waits 300 ms after the last change before calling `solve`.
  - `type AmountSource = 'sell' | 'buy'`
  - `useSwapAmounts({ tokenInDecimals, tokenOutDecimals, solve, solveKey }): { source: AmountSource; typed: string; amountIn: bigint; reverseStatus: ReverseStatus; sellText: string; buyTypedText: string; onSellChange(v: string): void; onBuyChange(v: string): void; flip(): void; reset(): void }` where `sellText` = `typed` when `source==='sell'`, else the derived input formatted (`''` until derived), and `buyTypedText` = `typed` when `source==='buy'`, else `''`.

- [ ] **Step 1: Write failing tests for `useReverseQuote`**

```ts
// fe/src/trading/use-reverse-quote.test.ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVERSE_QUOTE_DEBOUNCE_MS, useReverseQuote } from './use-reverse-quote';
import type { ReverseSolve } from './reverse-quote';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERSE_QUOTE_DEBOUNCE_MS + 1); });
}

describe('useReverseQuote', () => {
  it('is idle and never calls solve for a zero target', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 5n);
    const { result } = renderHook(() => useReverseQuote({ targetOut: 0n, solve, solveKey: 'k' }));
    await settle();
    expect(result.current).toEqual({ amountIn: null, status: 'idle' });
    expect(solve).not.toHaveBeenCalled();
  });

  it('is unavailable (not an error) when there is no solver, e.g. wallet disconnected', async () => {
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve: null, solveKey: 'k' }));
    await settle();
    expect(result.current).toEqual({ amountIn: null, status: 'unavailable' });
  });

  it('debounces, then resolves ok', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 7n);
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve, solveKey: 'k' }));
    expect(result.current.status).toBe('loading');
    expect(solve).not.toHaveBeenCalled();
    await settle();
    expect(solve).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ amountIn: 7n, status: 'ok' });
  });

  it('reports unavailable when solve returns null', async () => {
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve: async () => null, solveKey: 'k' }));
    await settle();
    expect(result.current).toEqual({ amountIn: null, status: 'unavailable' });
  });

  it('reports unavailable when solve throws', async () => {
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve: async () => { throw new Error('x'); }, solveKey: 'k' }));
    await settle();
    expect(result.current.status).toBe('unavailable');
  });

  it('fast typing: aborts the earlier search and applies only the last target', async () => {
    const signals: AbortSignal[] = [];
    const solve = vi.fn<ReverseSolve>(async (target, signal) => { signals.push(signal); return target * 2n; });
    const { result, rerender } = renderHook(({ t }) => useReverseQuote({ targetOut: t, solve, solveKey: 'k' }), { initialProps: { t: 10n } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    rerender({ t: 11n });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    rerender({ t: 12n });
    await settle();
    expect(solve).toHaveBeenCalledTimes(1);
    expect(solve).toHaveBeenCalledWith(12n, expect.anything());
    expect(result.current).toEqual({ amountIn: 24n, status: 'ok' });
  });

  it('discards a slow earlier result that resolves after a newer target started', async () => {
    let releaseFirst!: (v: bigint) => void;
    const solve = vi.fn<ReverseSolve>((target) =>
      target === 10n ? new Promise<bigint>((resolve) => { releaseFirst = resolve; }) : Promise.resolve(99n));
    const { result, rerender } = renderHook(({ t }) => useReverseQuote({ targetOut: t, solve, solveKey: 'k' }), { initialProps: { t: 10n } });
    await settle(); // first search now in flight
    rerender({ t: 20n });
    await settle();
    expect(result.current).toEqual({ amountIn: 99n, status: 'ok' });
    await act(async () => { releaseFirst(1n); });
    expect(result.current).toEqual({ amountIn: 99n, status: 'ok' });
  });

  it('re-solves when solveKey changes (e.g. direction flipped)', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 3n);
    const { rerender } = renderHook(({ k }) => useReverseQuote({ targetOut: 10n, solve, solveKey: k }), { initialProps: { k: 'a' } });
    await settle();
    rerender({ k: 'b' });
    await settle();
    expect(solve).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/trading/use-reverse-quote.test.ts`
Expected: FAIL — cannot resolve `./use-reverse-quote`.

- [ ] **Step 3: Implement `useReverseQuote`**

```ts
// fe/src/trading/use-reverse-quote.ts
'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReverseSolve } from './reverse-quote';

export const REVERSE_QUOTE_DEBOUNCE_MS = 300;

export type ReverseStatus = 'idle' | 'loading' | 'ok' | 'unavailable';

export interface ReverseQuoteState {
  amountIn: bigint | null;
  status: ReverseStatus;
}

export interface UseReverseQuoteParams {
  targetOut: bigint;
  solve: ReverseSolve | null;
  // Identity of the solver's inputs (venue, direction, tokens). `solve` itself is intentionally NOT
  // an effect dependency — callers rebuild it every render; `solveKey` says when it really changed.
  solveKey: string;
}

export function useReverseQuote({ targetOut, solve, solveKey }: UseReverseQuoteParams): ReverseQuoteState {
  const [state, setState] = useState<ReverseQuoteState>({ amountIn: null, status: 'idle' });
  const solveRef = useRef(solve);
  solveRef.current = solve;

  useEffect(() => {
    if (targetOut <= 0n) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived async state when the input clears
      setState({ amountIn: null, status: 'idle' });
      return;
    }
    if (!solveRef.current) {
      setState({ amountIn: null, status: 'unavailable' });
      return;
    }
    setState({ amountIn: null, status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const run = solveRef.current;
      if (!run) { setState({ amountIn: null, status: 'unavailable' }); return; }
      run(targetOut, controller.signal).then(
        (amountIn) => {
          if (controller.signal.aborted) return;
          setState(amountIn === null ? { amountIn: null, status: 'unavailable' } : { amountIn, status: 'ok' });
        },
        () => {
          if (controller.signal.aborted) return;
          setState({ amountIn: null, status: 'unavailable' });
        },
      );
    }, REVERSE_QUOTE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [targetOut, solveKey]);

  return state;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/trading/use-reverse-quote.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write failing tests for `useSwapAmounts`**

```ts
// fe/src/trading/use-swap-amounts.test.ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVERSE_QUOTE_DEBOUNCE_MS } from './use-reverse-quote';
import { useSwapAmounts } from './use-swap-amounts';
import type { ReverseSolve } from './reverse-quote';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(REVERSE_QUOTE_DEBOUNCE_MS + 1); });

function setup(solve: ReverseSolve | null = async (t) => t * 2n) {
  return renderHook(() => useSwapAmounts({ tokenInDecimals: 18, tokenOutDecimals: 6, solve, solveKey: 'k' }));
}

describe('useSwapAmounts', () => {
  it('starts empty with the Sell side as the source', () => {
    const { result } = setup();
    expect(result.current).toMatchObject({ source: 'sell', typed: '', amountIn: 0n, sellText: '', buyTypedText: '' });
  });

  it('typing in Sell: amountIn is the parsed Sell amount, no reverse quote runs', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 1n);
    const { result } = setup(solve);
    act(() => result.current.onSellChange('1.5'));
    await settle();
    expect(result.current).toMatchObject({ source: 'sell', typed: '1.5', amountIn: 1_500_000_000_000_000_000n, sellText: '1.5', buyTypedText: '' });
    expect(solve).not.toHaveBeenCalled();
  });

  it('typing in Buy: amountIn comes from the reverse quote and the Sell text shows it', async () => {
    const { result } = setup(async (target) => target * 10n ** 12n); // 6-dec target -> 18-dec input
    act(() => result.current.onBuyChange('2'));
    expect(result.current).toMatchObject({ source: 'buy', typed: '2', buyTypedText: '2', amountIn: 0n, sellText: '' });
    await settle();
    expect(result.current.amountIn).toBe(2_000_000n * 10n ** 12n);
    expect(result.current.sellText).toBe('2');
    expect(result.current.reverseStatus).toBe('ok');
  });

  it('typing in Buy with an unsolvable target: amountIn stays 0 and status is unavailable', async () => {
    const { result } = setup(async () => null);
    act(() => result.current.onBuyChange('999999'));
    await settle();
    expect(result.current).toMatchObject({ amountIn: 0n, sellText: '', reverseStatus: 'unavailable' });
  });

  it('flip keeps the typed number on the same token by moving the source to the other side', () => {
    const { result } = setup();
    act(() => result.current.onSellChange('5'));
    act(() => result.current.flip());
    expect(result.current).toMatchObject({ source: 'buy', typed: '5', buyTypedText: '5', sellText: '' });
    act(() => result.current.flip());
    expect(result.current).toMatchObject({ source: 'sell', typed: '5', sellText: '5' });
  });

  it('garbage input yields zero amounts and never calls the solver', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 1n);
    const { result } = setup(solve);
    for (const bad of ['.', '1e5', 'abc', '-1']) {
      act(() => result.current.onBuyChange(bad));
      await settle();
      expect(result.current.amountIn).toBe(0n);
    }
    expect(solve).not.toHaveBeenCalled();
  });

  it('reset clears the typed amount', () => {
    const { result } = setup();
    act(() => result.current.onSellChange('5'));
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ typed: '', amountIn: 0n });
  });
});
```

- [ ] **Step 6: Run to verify failure, then implement**

Run: `npx vitest run src/trading/use-swap-amounts.test.ts` → FAIL (module missing). Then:

```ts
// fe/src/trading/use-swap-amounts.ts
'use client';

import { useState } from 'react';
import { formatUnits } from 'viem';
import { parseAmountSafe } from './amount';
import type { ReverseSolve } from './reverse-quote';
import { useReverseQuote, type ReverseStatus } from './use-reverse-quote';

export type AmountSource = 'sell' | 'buy';

export interface UseSwapAmountsParams {
  tokenInDecimals: number;
  tokenOutDecimals: number;
  solve: ReverseSolve | null;
  solveKey: string;
}

export interface SwapAmounts {
  source: AmountSource;
  typed: string;
  // The exact-input amount every venue executes with: parsed from the Sell box when the user typed
  // there, otherwise derived from the Buy box via the reverse quote (0n until derived/unavailable).
  amountIn: bigint;
  reverseStatus: ReverseStatus;
  sellText: string;
  buyTypedText: string;
  onSellChange: (value: string) => void;
  onBuyChange: (value: string) => void;
  flip: () => void;
  reset: () => void;
}

export function useSwapAmounts({ tokenInDecimals, tokenOutDecimals, solve, solveKey }: UseSwapAmountsParams): SwapAmounts {
  const [source, setSource] = useState<AmountSource>('sell');
  const [typed, setTyped] = useState('');

  const targetOut = source === 'buy' ? parseAmountSafe(typed, tokenOutDecimals) : 0n;
  const reverse = useReverseQuote({ targetOut, solve, solveKey });

  const amountIn = source === 'sell' ? parseAmountSafe(typed, tokenInDecimals) : (reverse.amountIn ?? 0n);
  const sellText = source === 'sell' ? typed : (reverse.amountIn !== null ? formatUnits(reverse.amountIn, tokenInDecimals) : '');

  return {
    source,
    typed,
    amountIn,
    reverseStatus: source === 'buy' ? reverse.status : 'idle',
    sellText,
    buyTypedText: source === 'buy' ? typed : '',
    onSellChange: (value) => { setSource('sell'); setTyped(value); },
    onBuyChange: (value) => { setSource('buy'); setTyped(value); },
    // The typed number belongs to a token, not to a card — flipping moves that token to the other
    // card, so the source moves with it and the typed text is kept.
    flip: () => setSource((current) => (current === 'sell' ? 'buy' : 'sell')),
    reset: () => setTyped(''),
  };
}
```

- [ ] **Step 7: Run to verify pass, typecheck, lint**

Run: `npx vitest run src/trading/use-reverse-quote.test.ts src/trading/use-swap-amounts.test.ts && npx tsc --noEmit && npx eslint src/trading/use-reverse-quote.ts src/trading/use-swap-amounts.ts`
Expected: all pass. If eslint flags `solveRef.current = solve` during render (react-hooks/refs), move that assignment into a `useEffect` without deps that runs before the main effect, or silence with a justified `eslint-disable-next-line` — match how other hooks in `fe/src/trading` handled it.

- [ ] **Step 8: Commit**

```bash
git add src/trading/use-reverse-quote.ts src/trading/use-reverse-quote.test.ts src/trading/use-swap-amounts.ts src/trading/use-swap-amounts.test.ts
git commit -m "feat: add useReverseQuote and useSwapAmounts for two-way amounts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `TradeCard`, `SwapShell`, USD helper

**Files:**
- Create: `fe/src/trading/trade-card.tsx`, `fe/src/trading/swap-shell.tsx`, `fe/src/trading/trade-usd.ts`, `fe/src/trading/trade-amount-format.ts`
- Test: `fe/src/trading/trade-card.test.tsx`, `fe/src/trading/swap-shell.test.tsx`, `fe/src/trading/trade-usd.test.ts`, `fe/src/trading/trade-amount-format.test.ts`

**Interfaces:**
- Consumes: `Input` (`@/components/ui/input`), `Button`, `TradeSettingsPopover` (props `settings`, `onChange`, `venueKind`), `formatUsd(value: string | null, decimals: number)` from `@/api/format`.
- Produces:
  - `TradeCardSide = { value: string; onChange: (value: string) => void; ariaLabel: string; selector: ReactNode; usdText: string | null; hint: string | null }`
  - `TradeCard({ sell: TradeCardSide; buy: TradeCardSide; onFlip: () => void; minReceived?: string | null; footer?: ReactNode })` — `minReceived` is the already-formatted text (e.g. `27.0063M PROMETHEUS`); when `null`/omitted the "Min received" row is not rendered. The Sell side's label is "Sell", the Buy side's "Buy". Flip button has `aria-label="Flip swap direction"`.
  - `SwapShell({ venueLabel: string; settings: TradeSettings; onSettingsChange: (s: TradeSettings) => void; venueKind: 'curve' | 'pool'; children: ReactNode })` — header with a "Swap" pill, a venue badge, the settings gear; children rendered below.
  - `formatTokenAmount(amount: bigint, decimals: number): string` — compact display (`27.0063M`), up to 4 fraction digits; a non-zero amount below 0.0001 → `<0.0001`; zero → `0`.
  - `minReceivedText(outputAmount: bigint | null, slippageBps: number | 'auto', venueKind: 'curve' | 'pool', decimals: number, symbol: string | null): string | null` — `null` when `outputAmount` is `null`; else `` `${formatTokenAmount(applySlippage(outputAmount, slippageBps, venueKind), decimals)} ${symbol ?? ''}`.trim() `` (lives in `trade-amount-format.ts`; it must call the same `applySlippage` the submit path uses).
  - `usdText(amount: bigint | null, decimals: number, priceUsd: string | null | undefined): string | null` — `null` when amount is `null`/`0n` or price missing; else `formatUsd(String(Number(formatUnits(amount, decimals)) * Number(priceUsd)), 2)`.

- [ ] **Step 1: Write failing tests**

```tsx
// fe/src/trading/trade-card.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeCard, type TradeCardSide } from './trade-card';

function side(overrides: Partial<TradeCardSide> = {}): TradeCardSide {
  return { value: '', onChange: vi.fn(), ariaLabel: 'Sell amount', selector: <button type="button">TOK</button>, usdText: null, hint: null, ...overrides };
}

describe('TradeCard', () => {
  it('renders Sell and Buy cards with editable inputs and token selectors', () => {
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount', selector: <button type="button">ETH</button> })} onFlip={vi.fn()} />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByLabelText('Sell amount')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Buy amount')).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'TOK' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ETH' })).toBeInTheDocument();
  });

  it('typing in either input reports to that side only', () => {
    const sell = side();
    const buy = side({ ariaLabel: 'Buy amount' });
    render(<TradeCard sell={sell} buy={buy} onFlip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '3' } });
    expect(buy.onChange).toHaveBeenCalledWith('3');
    expect(sell.onChange).not.toHaveBeenCalled();
  });

  it('shows the $ line only when usdText is set — never a placeholder', () => {
    const { rerender } = render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    rerender(<TradeCard sell={side({ usdText: '$12.34' })} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  it('shows a hint under the side it belongs to', () => {
    render(<TradeCard sell={side({ hint: 'Quote unavailable' })} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.getByText('Quote unavailable')).toBeInTheDocument();
  });

  it('shows the Min received row only when provided', () => {
    const { rerender } = render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.queryByText(/min received/i)).not.toBeInTheDocument();
    rerender(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} minReceived="27.0063M PROMETHEUS" />);
    expect(screen.getByText(/min received/i)).toBeInTheDocument();
    expect(screen.getByText('27.0063M PROMETHEUS')).toBeInTheDocument();
  });

  it('flip button calls onFlip', () => {
    const onFlip = vi.fn();
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={onFlip} />);
    fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('renders the footer below the cards', () => {
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} footer={<button type="button">Swap now</button>} />);
    expect(screen.getByRole('button', { name: 'Swap now' })).toBeInTheDocument();
  });
});
```

```tsx
// fe/src/trading/swap-shell.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SwapShell } from './swap-shell';

const settings = { slippageBps: 'auto' as const, deadlineMinutes: 30, oneClickTradeOptIn: false };

describe('SwapShell', () => {
  it('shows the Swap pill, the venue badge, the settings gear and its children', () => {
    render(<SwapShell venueLabel="Bonding curve" settings={settings} onSettingsChange={vi.fn()} venueKind="curve"><p>body</p></SwapShell>);
    expect(screen.getByText('Swap')).toBeInTheDocument();
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('shows no Limit/Buy/Sell tabs', () => {
    render(<SwapShell venueLabel="Uniswap V4 pool" settings={settings} onSettingsChange={vi.fn()} venueKind="pool"><p>x</p></SwapShell>);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Limit')).not.toBeInTheDocument();
  });
});
```

```ts
// fe/src/trading/trade-amount-format.test.ts
import { describe, expect, it } from 'vitest';
import { applySlippage } from './amount';
import { formatTokenAmount, minReceivedText } from './trade-amount-format';

describe('formatTokenAmount', () => {
  it('formats millions compactly with up to 4 fraction digits', () => {
    expect(formatTokenAmount(27_006_300_000_000_000_000_000_000n, 18)).toBe('27.0063M');
  });
  it('formats thousands and plain numbers', () => {
    expect(formatTokenAmount(1_500n * 10n ** 18n, 18)).toBe('1.5K');
    expect(formatTokenAmount(12_340_000_000_000_000_000n, 18)).toBe('12.34');
  });
  it('never shows a real non-zero amount as 0', () => {
    expect(formatTokenAmount(1n, 18)).toBe('<0.0001');
    expect(formatTokenAmount(0n, 18)).toBe('0');
  });
});

describe('minReceivedText', () => {
  it('is null (row hidden) when there is no quote', () => {
    expect(minReceivedText(null, 100, 'curve', 18, 'TOK')).toBeNull();
  });
  it('applies the same slippage math the submit path uses', () => {
    const out = 27_283_000_000_000_000_000_000_000n;
    const expected = formatTokenAmount(applySlippage(out, 100, 'curve'), 18);
    expect(minReceivedText(out, 100, 'curve', 18, 'PROMETHEUS')).toBe(`${expected} PROMETHEUS`);
    expect(minReceivedText(out, 100, 'curve', 18, 'PROMETHEUS')).toBe('27.0102M PROMETHEUS');
  });
  it('resolves Auto slippage per venue (curve 12%, pool 0.5%)', () => {
    const out = 1_000n * 10n ** 18n;
    expect(minReceivedText(out, 'auto', 'curve', 18, 'T')).toBe('880 T');
    expect(minReceivedText(out, 'auto', 'pool', 18, 'T')).toBe('995 T');
  });
  it('omits the symbol gracefully when unknown', () => {
    expect(minReceivedText(10n ** 18n, 0, 'pool', 18, null)).toBe('1');
  });
});
```

```ts
// fe/src/trading/trade-usd.test.ts
import { describe, expect, it } from 'vitest';
import { usdText } from './trade-usd';

describe('usdText', () => {
  it('multiplies the token amount by the USD price', () => {
    expect(usdText(2_000_000_000_000_000_000n, 18, '1.5')).toBe('$3.00');
  });
  it('is null (hidden), never $0, when there is no price', () => {
    expect(usdText(1_000_000_000_000_000_000n, 18, null)).toBeNull();
    expect(usdText(1_000_000_000_000_000_000n, 18, undefined)).toBeNull();
  });
  it('is null for a missing or zero amount', () => {
    expect(usdText(null, 18, '1.5')).toBeNull();
    expect(usdText(0n, 18, '1.5')).toBeNull();
  });
});
```

Check the actual accessible name of the gear in `trade-settings-popover.tsx` (it uses `fe/public/images/trading/settings.png`); if its `aria-label` isn't matched by `/settings/i`, adjust the shell test's query to the real label — do not change the popover.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/trading/trade-card.test.tsx src/trading/swap-shell.test.tsx src/trading/trade-usd.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

```ts
// fe/src/trading/trade-usd.ts
import { formatUnits } from 'viem';
import { formatUsd } from '@/api/format';

// USD value of a token amount, or null (line hidden) when there is no real price — null means
// unavailable, never "$0".
export function usdText(amount: bigint | null, decimals: number, priceUsd: string | null | undefined): string | null {
  if (amount === null || amount === 0n || priceUsd === null || priceUsd === undefined) return null;
  const value = Number(formatUnits(amount, decimals)) * Number(priceUsd);
  if (!Number.isFinite(value)) return null;
  return formatUsd(String(value), 2);
}
```

```ts
// fe/src/trading/trade-amount-format.ts
import { formatUnits } from 'viem';
import { applySlippage } from './amount';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 4 });

// Display-only. A real non-zero amount is never shown as 0 — it shows "<0.0001".
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return '0';
  const value = Number(formatUnits(amount, decimals));
  if (value < 0.0001) return '<0.0001';
  return compact.format(value);
}

// The row under the cards: the least the user accepts after slippage. Uses the very same
// applySlippage() the submit path feeds into minTokensOut / minQuoteOut / amountOutMinimum, so
// the number shown is the number sent. null (row hidden) when there is no quote.
export function minReceivedText(
  outputAmount: bigint | null,
  slippageBps: number | 'auto',
  venueKind: 'curve' | 'pool',
  decimals: number,
  symbol: string | null,
): string | null {
  if (outputAmount === null) return null;
  return `${formatTokenAmount(applySlippage(outputAmount, slippageBps, venueKind), decimals)} ${symbol ?? ''}`.trim();
}
```

```tsx
// fe/src/trading/trade-card.tsx
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface TradeCardSide {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  selector: ReactNode;
  // null hides the line — never render a placeholder "$0".
  usdText: string | null;
  // Short status under the amount (e.g. "Quote unavailable", "Estimating…"); null shows nothing.
  hint: string | null;
}

export interface TradeCardProps {
  sell: TradeCardSide;
  buy: TradeCardSide;
  onFlip: () => void;
  // Pre-formatted "least you receive after slippage" text; null/omitted hides the row.
  minReceived?: string | null;
  footer?: ReactNode;
}

// Presentational only: two stacked cards (Sell on top, Buy below) with the flip arrow overlapping
// the seam, as on Uniswap. No trade logic lives here — panels own state, quotes and submission.
export function TradeCard({ sell, buy, onFlip, minReceived = null, footer }: TradeCardProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex flex-col gap-1">
        <Side label="Sell" side={sell} className="bg-card border border-border" />
        <Side label="Buy" side={buy} className="bg-muted" />
        <Button type="button" variant="outline" size="sm" aria-label="Flip swap direction"
          className="absolute top-1/2 left-1/2 z-10 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 border-background bg-muted p-0"
          onClick={onFlip}>
          <span aria-hidden="true">↓</span>
        </Button>
      </div>
      {minReceived !== null && (
        <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
          <span>Min received</span>
          <span>{minReceived}</span>
        </div>
      )}
      {footer}
    </div>
  );
}

function Side({ label, side, className }: { label: string; side: TradeCardSide; className: string }) {
  return (
    <div className={`flex flex-col gap-1 rounded-2xl p-4 ${className}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center justify-between gap-2">
        <Input
          aria-label={side.ariaLabel}
          type="number"
          inputMode="decimal"
          placeholder="0"
          value={side.value}
          onChange={(event) => side.onChange(event.target.value)}
          className="h-12 flex-1 border-0 bg-transparent px-0 text-3xl font-medium shadow-none focus-visible:ring-0"
        />
        {side.selector}
      </div>
      <div className="flex min-h-5 items-center justify-between text-sm text-muted-foreground">
        <span>{side.usdText}</span>
        <span>{side.hint}</span>
      </div>
    </div>
  );
}
```

```tsx
// fe/src/trading/swap-shell.tsx
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { TradeSettingsPopover } from './trade-settings-popover';
import type { TradeSettings } from './use-trade-settings';

export interface SwapShellProps {
  // Names the venue the trade really executes on ("Bonding curve", "Uniswap V3 pool", …) —
  // fees and slippage differ by venue, so it is never hidden.
  venueLabel: string;
  settings: TradeSettings;
  onSettingsChange: (settings: TradeSettings) => void;
  venueKind: 'curve' | 'pool';
  children: ReactNode;
}

export function SwapShell({ venueLabel, settings, onSettingsChange, venueKind, children }: SwapShellProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-4 py-1.5 text-base font-semibold">Swap</span>
          <Badge variant="outline">{venueLabel}</Badge>
        </div>
        <TradeSettingsPopover settings={settings} onChange={onSettingsChange} venueKind={venueKind} />
      </div>
      {children}
    </div>
  );
}
```

Verify `Badge` accepts `variant="outline"` in `fe/src/components/ui/badge.tsx`; if not, use its real variant name.

- [ ] **Step 4: Run to verify pass, typecheck**

Run: `npx vitest run src/trading/trade-card.test.tsx src/trading/swap-shell.test.tsx src/trading/trade-usd.test.ts src/trading/trade-amount-format.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trading/trade-card.tsx src/trading/trade-card.test.tsx src/trading/swap-shell.tsx src/trading/swap-shell.test.tsx src/trading/trade-usd.ts src/trading/trade-usd.test.ts src/trading/trade-amount-format.ts src/trading/trade-amount-format.test.ts
git commit -m "feat: add TradeCard and SwapShell presentational components

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Migrate the V3 `SwapPanel` (`swap-panel.tsx`)

**Files:**
- Modify: `fe/src/trading/swap-panel.tsx`
- Modify (test): `fe/src/trading/swap-panel.test.tsx`

**Interfaces:**
- Consumes: `useSwapAmounts` (Task 3), `makeV3ReverseSolve` (Task 2), `TradeCard`, `SwapShell`, `usdText` (Task 4); wagmi `usePublicClient`.
- Produces: `SwapPanelProps` gains optional `usdPrice?: { tokenAddress: Address; priceUsd: string | null }` (shows `$` only on the side whose token address matches). All other props unchanged.

- [ ] **Step 1: Update the wagmi mock and add the new failing tests**

In `swap-panel.test.tsx`: add to the hoisted `hooks`: `publicClient: { simulateContract: vi.fn() } as { simulateContract: ReturnType<typeof vi.fn> } | undefined`, and to the `vi.mock('wagmi', …)` object: `usePublicClient: () => hooks.publicClient`. Reset `hooks.publicClient = { simulateContract: vi.fn() }` in `beforeEach`. Replace every `screen.getByLabelText(/amount/i)` with `screen.getByLabelText('Sell amount')`, and `getByText('Sell')` stays valid. Existing behavioral assertions (Approve/Swap/permit/batch/slippage) must stay and keep passing. Then add:

```tsx
it('typing in Buy derives the Sell amount via the V3 exact-out quoter and submits exact-input with it', async () => {
  vi.useFakeTimers();
  hooks.publicClient!.simulateContract.mockResolvedValue({ result: [2_000_000_000_000_000_000n, 0n, 1, 1n] });
  hooks.simulateData = { result: [1_000_000_000_000_000_000n, 0n, 1, 1n] }; // forward quote at X
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '1' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(hooks.publicClient!.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'quoteExactOutputSingle' }));
  expect(screen.getByLabelText('Sell amount')).toHaveValue(2);
  vi.useRealTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
  // the executed call carries the derived 2e18 as exact input (value: 0 for an ERC20 input; assert on args[1] encoding via the existing submit assertion helper in this file)
  expect(hooks.writeContract).toHaveBeenCalled();
});

it('shows "Quote unavailable" and disables Swap when the reverse quote fails', async () => {
  vi.useFakeTimers();
  hooks.publicClient!.simulateContract.mockRejectedValue(new Error('revert'));
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '999999999' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText('Quote unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  vi.useRealTimers();
});

it('flip keeps the typed number on the same token', () => {
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
  expect(screen.getByLabelText('Buy amount')).toHaveValue(5);
});

it('shows Min received from the quote with the user slippage, and hides it with no quote', () => {
  localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 100, deadlineMinutes: 30, oneClickTradeOptIn: false }));
  hooks.simulateData = { result: [1_000_000_000_000_000_000_000n, 0n, 1, 1n] }; // quote: 1000 tokens out
  const { unmount } = render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } });
  expect(screen.getByText('Min received')).toBeInTheDocument();
  expect(screen.getByText(/^990 /)).toBeInTheDocument(); // 1000 minus 1% slippage
  unmount();
  hooks.simulateData = undefined;
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } });
  expect(screen.queryByText('Min received')).not.toBeInTheDocument();
});

it('shows a USD line only on the side whose token has a price', () => {
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} usdPrice={{ tokenAddress: tokenA.address, priceUsd: '2' }} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '3' } });
  expect(screen.getByText('$6.00')).toBeInTheDocument();
});
```
(Import `act` from `@testing-library/react`. Where the existing file asserts the exact submit args for a swap, reuse that same assertion shape for the derived-amount test instead of the loose `toHaveBeenCalled()` above — the point is that the encoded `amountIn` equals the derived `2e18`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/trading/swap-panel.test.tsx`
Expected: FAIL (no `Buy amount` input yet; old selectors replaced).

- [ ] **Step 3: Rewrite the panel's state and JSX (logic untouched)**

In `swap-panel.tsx`:

1. Replace `const [amount, setAmount] = useState('')` and `const amountIn = parseAmountSafe(...)` with:

```tsx
const client = usePublicClient({ chainId: robinhoodChain.id });
const solve = useMemo(
  () => (client && fee !== null
    ? makeV3ReverseSolve(client, { tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee })
    : null),
  [client, fee, tokenIn.address, tokenOut.address],
);
const amounts = useSwapAmounts({
  tokenInDecimals: tokenIn.decimals,
  tokenOutDecimals: tokenOut.decimals,
  solve,
  solveKey: `v3:${poolAddress}:${tokenIn.address}:${tokenOut.address}:${fee}`,
});
const amountIn = amounts.amountIn;
```
`tokenIn`/`tokenOut` derive from `direction` exactly as today (keep `direction` state). Imports: `useMemo`, `usePublicClient` (wagmi), `makeV3ReverseSolve`, `useSwapAmounts`, `TradeCard`, `SwapShell`, `usdText`, `minReceivedText` (from `./trade-amount-format`). The Min received row uses the same `settings.slippageBps` and `'pool'` venue kind that `submitSwap`'s `applySlippage` uses — never recompute slippage a second way.

2. Every `setAmount('')` (the `onSuccess` callbacks) becomes `amounts.reset()`. Flip handler: `() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); amounts.flip(); }` (keeps the typed number; no more clearing).

3. Replace the returned JSX's header + cards block with:

```tsx
const buyText = amounts.source === 'buy'
  ? amounts.buyTypedText
  : (quote.outputAmount !== null ? formatUnits(quote.outputAmount, tokenOut.decimals) : '');
const reverseUnavailable = amounts.source === 'buy' && amounts.reverseStatus === 'unavailable';
const sellHint = reverseUnavailable ? 'Quote unavailable'
  : amounts.source === 'buy' && amounts.reverseStatus === 'loading' ? 'Estimating…' : null;
const buyHint = amounts.source === 'sell' && amountIn > 0n && quote.outputAmount === null && quote.errorMessage
  ? `Quote unavailable: ${quote.errorMessage}` : null;
const priceFor = (token: SwapToken) =>
  usdPrice && usdPrice.tokenAddress.toLowerCase() === token.address.toLowerCase() ? usdPrice.priceUsd : null;

return (
  <SwapShell venueLabel="Uniswap V3 pool" venueKind="pool" settings={settings} onSettingsChange={update}>
    <TradeCard
      sell={{
        value: amounts.sellText, onChange: amounts.onSellChange, ariaLabel: 'Sell amount',
        selector: (<TokenSelector options={sideOptions(tokenIn)} selected={selectedOption(tokenIn)} onSelect={(key) => handleSelect(tokenIn, key)} chainId={robinhoodChain.id} />),
        usdText: usdText(amountIn, tokenIn.decimals, priceFor(tokenIn)), hint: sellHint,
      }}
      buy={{
        value: buyText, onChange: amounts.onBuyChange, ariaLabel: 'Buy amount',
        selector: (<TokenSelector options={sideOptions(tokenOut)} selected={selectedOption(tokenOut)} onSelect={(key) => handleSelect(tokenOut, key)} chainId={robinhoodChain.id} />),
        usdText: usdText(quote.outputAmount, tokenOut.decimals, priceFor(tokenOut)), hint: buyHint,
      }}
      onFlip={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); amounts.flip(); }}
      minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'pool', tokenOut.decimals, displaySymbol(tokenOut, nativeOut))}
      footer={<>
        {permit2.signError && (<p role="alert" className="text-sm text-destructive">{permit2.signError}</p>)}
        <ApproveOrActionButton … /* unchanged props, EXCEPT: outputAmount={reverseUnavailable ? null : (erc20Allowance.isAllowanceLoading ? null : quote.outputAmount)} */ />
        <TradeStatus … /* unchanged */ />
      </>}
    />
  </SwapShell>
);
```
Add `usdPrice?: { tokenAddress: Address; priceUsd: string | null }` to `SwapPanelProps` and the function parameters. Remove now-unused imports (`Input`, `Button`, `TradeSettingsPopover`, `parseAmountSafe` if unused). Keep `submitSwap`, quote hook, permit2, allowance, batching, ETH/WETH handling byte-for-byte.

- [ ] **Step 4: Run to verify pass, typecheck, lint**

Run: `npx vitest run src/trading/swap-panel.test.tsx && npx tsc --noEmit && npx eslint src/trading/swap-panel.tsx`
Expected: all pass. Do not weaken existing behavior assertions; if one fails, the migration changed behavior — fix the panel.

- [ ] **Step 5: Commit**

```bash
git add src/trading/swap-panel.tsx src/trading/swap-panel.test.tsx
git commit -m "feat: V3 swap panel uses the shared card UI with two-way quoting

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Migrate the V4 `V4SwapPanel` (`v4-swap-panel.tsx`)

**Files:**
- Modify: `fe/src/trading/v4-swap-panel.tsx`
- Modify (test): `fe/src/trading/v4-swap-panel.test.tsx`

**Interfaces:**
- Consumes: as Task 5, with `makeV4ReverseSolve`.
- Produces: `V4SwapPanelProps` gains `usdPrice?: { tokenAddress: Address; priceUsd: string | null }`; `V4SwapToken` gains optional `logoUri?: string | null` (default `null`) so the token pills can show logos (callers that don't have one pass nothing).

- [ ] **Step 1: Update mocks and add failing tests**

Same wagmi-mock additions as Task 5 (`usePublicClient`, `hooks.publicClient`), selectors `getByLabelText(/amount/i)` → `getByLabelText('Sell amount')`. Add tests mirroring Task 5's five (Buy-derives-Sell, unavailable disables, flip keeps typed number, Min received row, USD line), adapted for V4: the reverse test mocks `publicClient.simulateContract` with an implementation that returns `{ result: [args.args[0].exactAmount * 2n, 0n] }` (a linear 2× exact-in quote) and asserts the Sell box ends up holding a value whose doubled amount covers the typed Buy target, and that `simulateContract` was called with `functionName: 'quoteExactInputSingleV4'`. Use fake timers + `advanceTimersByTimeAsync(400)` then run enough ticks for the search (each solver call is a resolved promise: `await act(async () => { await vi.advanceTimersByTimeAsync(400); })` once is enough because promise chains flush within it; if not, loop the advance a few times).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/trading/v4-swap-panel.test.tsx` → FAIL.

- [ ] **Step 3: Apply the same transformation as Task 5**

- `solve = useMemo(() => client ? makeV4ReverseSolve(client, { poolKey, zeroForOne }) : null, [client, poolKey, zeroForOne])` with `solveKey: \`v4:${poolKey.currency0}:${poolKey.currency1}:${poolKey.fee}:${poolKey.hooks}:${zeroForOne}\``. `poolKey` is a prop object — its identity can change each parent render, so key the memo on `JSON`-free primitives: `[client, poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks, zeroForOne]`.
- Token selectors: V4 has no ETH/WETH toggle today; render `TokenSelector` with a single fixed option per side: `{ key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri ?? null }`, `onSelect={() => {}}`, `chainId={robinhoodChain.id}`. Native ETH (`zeroAddress`) shows symbol `ETH` as today (the caller already passes the symbol).
- Venue label `"Uniswap V4 pool"`; `venueKind="pool"`.
- Pass `minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'pool', tokenOut.decimals, tokenOut.symbol)}` to `TradeCard` (same `applySlippage` inputs as `submitSwap`).
- Flip: `setDirection(...)` + `amounts.flip()`; every `setAmount('')` → `amounts.reset()`.
- Same `buyText`/hints/`outputAmount` gating (`reverseUnavailable ? null : …`) as Task 5. Keep `submitSwap`, permit2, allowance, batching unchanged.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/trading/v4-swap-panel.test.tsx && npx tsc --noEmit && npx eslint src/trading/v4-swap-panel.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trading/v4-swap-panel.tsx src/trading/v4-swap-panel.test.tsx
git commit -m "feat: V4 swap panel uses the shared card UI with two-way quoting

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `CurveSwapPanel` (replaces Buy/Sell/CurveTrade panels)

**Files:**
- Create: `fe/src/trading/curve-swap-panel.tsx`
- Test: `fe/src/trading/curve-swap-panel.test.tsx`
- Delete (end of task, after the new tests pass): `fe/src/trading/buy-panel.tsx`, `buy-panel.test.tsx`, `sell-panel.tsx`, `sell-panel.test.tsx`, `curve-trade-panel.tsx`, `curve-trade-panel.test.tsx`

**Interfaces:**
- Consumes: everything `BuyPanel`/`SellPanel` use today (`useCurveQuote`, `useTokenAllowance`, `useTradeSubmission`, `useCanBatchCalls`, `usePaymasterCapability`, `useRefetchQuoteAfterApproval`, `ApproveOrActionButton`, `TradeStatus`, `applySlippage`, `curveTradeAbi`, `erc20Abi`) plus Tasks 2–4.
- Produces: `CurveSwapPanel(props: CurveSwapPanelProps)`:

```ts
export interface CurveSwapPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  tokenDecimals: number;        // the launched token's own decimals
  tokenSymbol?: string | null;
  tokenLogoUri?: string | null;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
  usdPrice?: { tokenAddress: Address; priceUsd: string | null };
}
```

- [ ] **Step 1: Port the behavior tests, then add the new ones**

Open `buy-panel.test.tsx` and `sell-panel.test.tsx`. Create `curve-swap-panel.test.tsx` with the same hoisted-`hooks` + `vi.mock('wagmi', …)` scaffolding (plus `usePublicClient`), and port EVERY test from both files into one `describe` each — "buy direction (default)" and "sell direction (after flip)" — adapting only: the component under test, the input selector (`getByLabelText('Sell amount')` — in the default buy direction the Sell card is the quote asset; after clicking "Flip swap direction" the Sell card is the launched token), and the button label (`Swap` instead of `Buy`/`Sell`; the "Not enough X"/"Approve"/"Enter an amount"/"Switch network" labels are unchanged). Keep each test's assertions on `writeContract`/`sendCalls` args identical (`buy`/`sell` function names, `value`, exact-amount approve, `minTokensOut`/`minQuoteOut` from `applySlippage(…,'curve')`). Add:

```tsx
describe('two-way amounts', () => {
  it('buy direction: typing in Buy derives the quote-asset amount by inverting the buy() simulation', async () => {
    vi.useFakeTimers();
    // linear 10 tokens per quote unit
    hooks.publicClient!.simulateContract.mockImplementation(async (a: { args: [bigint] }) => ({ result: a.args[0] * 10n }));
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '10' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const derived = Number((screen.getByLabelText('Sell amount') as HTMLInputElement).value);
    expect(derived).toBeGreaterThanOrEqual(1);          // 10 tokens out needs >= 1 unit in
    expect(derived).toBeLessThan(1.001);                // within 0.01%-ish tolerance
    expect(hooks.publicClient!.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'buy', account: hooks.account.address }));
    vi.useRealTimers();
  });

  it('sell direction: typing in Buy simulates sell(), not buy()', async () => {
    vi.useFakeTimers();
    hooks.publicClient!.simulateContract.mockImplementation(async (a: { args: [bigint] }) => ({ result: a.args[0] / 2n }));
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(hooks.publicClient!.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'sell' }));
    vi.useRealTimers();
  });

  it('shows "Quote unavailable" and disables the button when the reverse simulation reverts (e.g. not yet approved)', async () => {
    vi.useFakeTimers();
    hooks.publicClient!.simulateContract.mockRejectedValue(new Error('revert'));
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '5' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByText('Quote unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
    vi.useRealTimers();
  });

  it('disconnected wallet: typing in Buy shows unavailable without calling the RPC', async () => {
    vi.useFakeTimers();
    hooks.account.address = undefined;
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '5' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(hooks.publicClient!.simulateContract).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('flipping switches the venue call (buy ⇄ sell), keeps the typed number, and the badge stays "Bonding curve"', () => {
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
    expect(screen.getByLabelText('Buy amount')).toHaveValue(5);
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
  });

  it('shows Min received using curve slippage: the same minTokensOut that is submitted', () => {
    localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 100, deadlineMinutes: 30, oneClickTradeOptIn: false }));
    hooks.simulateData = { result: 1_000_000_000_000_000_000_000n }; // forward quote: 1000 tokens
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '0.001' } });
    expect(screen.getByText('Min received')).toBeInTheDocument();
    expect(screen.getByText(/^990/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    // 990e18 raw must equal the minTokensOut argument actually sent to buy()
    expect(hooks.writeContract.mock.calls[0][0].args[1]).toBe(990_000_000_000_000_000_000n);
  });

  it('has no Buy/Sell/Limit tabs', () => {
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/trading/curve-swap-panel.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement `curve-swap-panel.tsx`**

Compose from `buy-panel.tsx` + `sell-panel.tsx` (read both files; the code below shows the new parts; everything else is carried over unchanged):

```tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type Address, formatUnits, zeroAddress } from 'viem';
import { useAccount, useBalance, usePublicClient, useReadContract } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';
// …the same trading-hook/ABI imports buy-panel.tsx and sell-panel.tsx have today…
import { makeCurveReverseSolve } from './reverse-quote';
import { useSwapAmounts } from './use-swap-amounts';
import { SwapShell } from './swap-shell';
import { TradeCard } from './trade-card';
import { TokenSelector } from './token-selector';
import { usdText } from './trade-usd';
import { minReceivedText } from './trade-amount-format';

export function CurveSwapPanel({ curveAddress, tokenAddress, tokenDecimals, tokenSymbol, tokenLogoUri, quoteAsset, explorerBase, usdPrice }: CurveSwapPanelProps) {
  // 'buy' = quote asset -> launched token (curve.buy); 'sell' = launched token -> quote (curve.sell).
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isNativeQuote = quoteAsset.address === zeroAddress;
  const isWrongChain = chainId !== robinhoodChain.id;

  const launched = { address: tokenAddress, symbol: tokenSymbol ?? null, decimals: tokenDecimals, logoUri: tokenLogoUri ?? null };
  const quoteTok = { address: quoteAsset.address, symbol: quoteAsset.symbol, decimals: quoteAsset.decimals, logoUri: null as string | null };
  const tokenIn = direction === 'buy' ? quoteTok : launched;
  const tokenOut = direction === 'buy' ? launched : quoteTok;

  const client = usePublicClient({ chainId: robinhoodChain.id });
  const solve = useMemo(
    () => (client && account
      ? makeCurveReverseSolve(client, { curveAddress, direction, account, isNativeQuote })
      : null),
    [client, account, curveAddress, direction, isNativeQuote],
  );
  const amounts = useSwapAmounts({
    tokenInDecimals: tokenIn.decimals,
    tokenOutDecimals: tokenOut.decimals,
    solve,
    solveKey: `curve:${curveAddress}:${direction}:${account ?? ''}`,
  });
  const amountIn = amounts.amountIn;

  // Balances: the Sell side's token. Native quote -> useBalance; otherwise an ERC20 balanceOf on
  // whichever token is being sold (quote asset when buying, the launched token when selling).
  const sellsNative = direction === 'buy' && isNativeQuote;
  const nativeBalance = useBalance({ address: account, query: { enabled: sellsNative && Boolean(account) } });
  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address, abi: erc20Abi, functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: !sellsNative && Boolean(account) },
  });
  const allowance = useTokenAllowance(sellsNative ? undefined : tokenIn.address, sellsNative ? undefined : curveAddress);
  const quote = useCurveQuote({
    curveAddress, direction, amountIn, recipient: account,
    nativeValue: direction === 'buy' && isNativeQuote ? amountIn : undefined,
  });
  // submission / canBatch / paymasterCapable / isSubmitting / wasConfirmed effect /
  // useRefetchQuoteAfterApproval: copy verbatim from buy-panel.tsx.

  const hasInsufficientBalance = sellsNative
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (tokenInBalance ?? 0n) < amountIn;
  const needsApproval = !sellsNative && amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  function submitTrade() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const minOut = applySlippage(quote.outputAmount, settings.slippageBps, 'curve');
    const call = direction === 'buy'
      ? { address: curveAddress, abi: curveTradeAbi, functionName: 'buy', args: [amountIn, minOut, account], value: isNativeQuote ? amountIn : undefined }
      : { address: curveAddress, abi: curveTradeAbi, functionName: 'sell', args: [amountIn, minOut, account] };
    if (needsApproval && canBatch) {
      // Exact amountIn, never maxUint256 (unlike Permit2's approval) — same as BuyPanel/SellPanel.
      const approveCall = { address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [curveAddress, amountIn] };
      const capabilities = PAYMASTER_SERVICE_URL && paymasterCapable ? { paymasterService: { url: PAYMASTER_SERVICE_URL } } : undefined;
      submission.submitBatch([approveCall, call], { onSuccess: amounts.reset }, capabilities);
    } else {
      submission.submit(call, { onSuccess: amounts.reset });
    }
  }

  const reverseUnavailable = amounts.source === 'buy' && amounts.reverseStatus === 'unavailable';
  const buyText = amounts.source === 'buy'
    ? amounts.buyTypedText
    : (quote.outputAmount !== null ? formatUnits(quote.outputAmount, tokenOut.decimals) : '');
  const sellHint = reverseUnavailable ? 'Quote unavailable'
    : amounts.source === 'buy' && amounts.reverseStatus === 'loading' ? 'Estimating…' : null;
  const buyHint = amounts.source === 'sell' && amountIn > 0n && quote.outputAmount === null && quote.errorMessage
    ? `Quote unavailable: ${quote.errorMessage}` : null;
  const priceFor = (address: Address) =>
    usdPrice && usdPrice.tokenAddress.toLowerCase() === address.toLowerCase() ? usdPrice.priceUsd : null;
  const pill = (t: typeof tokenIn) => (
    <TokenSelector
      options={[{ key: t.address, symbol: t.symbol ?? '—', logoUri: t.logoUri }]}
      selected={{ key: t.address, symbol: t.symbol ?? '—', logoUri: t.logoUri }}
      onSelect={() => {}}
      chainId={robinhoodChain.id}
    />
  );

  return (
    <SwapShell venueLabel="Bonding curve" venueKind="curve" settings={settings} onSettingsChange={update}>
      <TradeCard
        sell={{ value: amounts.sellText, onChange: amounts.onSellChange, ariaLabel: 'Sell amount', selector: pill(tokenIn),
                usdText: usdText(amountIn, tokenIn.decimals, priceFor(tokenIn.address)), hint: sellHint }}
        buy={{ value: buyText, onChange: amounts.onBuyChange, ariaLabel: 'Buy amount', selector: pill(tokenOut),
               usdText: usdText(quote.outputAmount, tokenOut.decimals, priceFor(tokenOut.address)), hint: buyHint }}
        onFlip={() => { setDirection(direction === 'buy' ? 'sell' : 'buy'); amounts.flip(); }}
        minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'curve', tokenOut.decimals, tokenOut.symbol)}
        footer={<>
          <ApproveOrActionButton
            needsApproval={needsApproval}
            amountIn={amountIn}
            isWrongChain={isWrongChain}
            hasInsufficientBalance={hasInsufficientBalance}
            tokenInSymbol={tokenIn.symbol ?? undefined}
            canBatchApprove={canBatch}
            outputAmount={reverseUnavailable ? null : quote.outputAmount}
            isSubmitting={isSubmitting}
            allowance={allowance}
            actionLabel="Swap"
            onAction={submitTrade}
          />
          <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
        </>}
      />
    </SwapShell>
  );
}
```

Note the quote-asset pill's logo is `null` (the letter avatar) — the launch detail does not carry a quote-asset logo today; do not invent one.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/trading/curve-swap-panel.test.tsx && npx tsc --noEmit && npx eslint src/trading/curve-swap-panel.tsx`. Every ported assertion from the old buy/sell tests must pass unchanged in meaning; a failing ported test means the merge changed behavior.

- [ ] **Step 5: Delete the superseded panels**

`launch-detail.tsx` still imports `CurveTradePanel` until Task 8 — to keep this commit green, do the deletion in Task 8's commit instead. In this task only create the new files.

- [ ] **Step 6: Commit**

```bash
git add src/trading/curve-swap-panel.tsx src/trading/curve-swap-panel.test.tsx
git commit -m "feat: add CurveSwapPanel merging curve buy and sell into one swap panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Wire everything in, update the preview, remove old panels

**Files:**
- Modify: `fe/src/trading/swap-panel-preview.tsx`, `fe/src/features/launch/launch-detail.tsx`, `fe/src/features/pools/swap-trigger.tsx`
- Modify (tests): `fe/src/features/launch/launch-detail.test.tsx`, plus a new `fe/src/trading/swap-panel-preview.test.tsx`
- Delete: `fe/src/trading/buy-panel.tsx`, `buy-panel.test.tsx`, `sell-panel.tsx`, `sell-panel.test.tsx`, `curve-trade-panel.tsx`, `curve-trade-panel.test.tsx`

**Interfaces:**
- Consumes: `CurveSwapPanel`, `SwapPanel`, `V4SwapPanel` (Tasks 5–7), `TradeCard`, `SwapShell`.
- Produces: `SwapPanelPreview({ sellSymbol, buySymbol })` — same props as today.

- [ ] **Step 1: Write failing tests**

```tsx
// fe/src/trading/swap-panel-preview.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SwapPanelPreview } from './swap-panel-preview';

describe('SwapPanelPreview', () => {
  it('renders the swap card layout with fake data, clearly labeled preview-only and disabled', () => {
    render(<SwapPanelPreview sellSymbol="TOK" buySymbol="ETH" />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText(/preview only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview only/i })).toBeDisabled();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
```
In `launch-detail.test.tsx`: update any assertion that looked for `Buy`/`Sell` tabs of the curve panel to look for the single `Swap` panel (`getByText('Bonding curve')` badge, `getByLabelText('Sell amount')`); add a test that, for a launch with `priceUsd: '2'` and a curve venue, typing `3` in `Sell amount` is NOT required — instead assert the panel receives `usdPrice` by typing in the launched-token side (flip first) and expecting `$6.00`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/trading/swap-panel-preview.test.tsx src/features/launch/launch-detail.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`swap-panel-preview.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { TradeCard } from './trade-card';

const noop = () => {};
const pill = (symbol: string) => (
  <span className="rounded-full border border-border px-3 py-1.5 text-sm font-medium">{symbol}</span>
);

// Fake data on purpose and labeled as such: shown when a launch has no tradable venue yet, so the
// layout is visible without implying a real quote.
export function SwapPanelPreview({ sellSymbol, buySymbol }: { sellSymbol: string; buySymbol: string }) {
  return (
    <div className="flex flex-col gap-3" aria-label="Swap panel preview">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-muted px-4 py-1.5 text-base font-semibold">Swap</span>
        <span className="text-xs text-muted-foreground">Preview only · fake data</span>
      </div>
      <TradeCard
        sell={{ value: '1000', onChange: noop, ariaLabel: 'Preview sell amount', selector: pill(sellSymbol), usdText: null, hint: null }}
        buy={{ value: '0.42', onChange: noop, ariaLabel: 'Preview receive amount', selector: pill(buySymbol), usdText: null, hint: 'Sample quote' }}
        onFlip={noop}
        footer={<Button type="button" disabled>Preview only</Button>}
      />
    </div>
  );
}
```
(The preview's inputs are controlled with a no-op `onChange`, so they are effectively read-only; React may warn about a controlled input without a handler — `onChange={noop}` satisfies it.)

`launch-detail.tsx`: replace the `CurveTradePanel` block with

```tsx
<CurveSwapPanel
  curveAddress={activeCurveVenue.ref as `0x${string}`}
  tokenAddress={detail.tokenAddress as `0x${string}`}
  tokenDecimals={detail.tokenDecimals}
  tokenSymbol={detail.symbol}
  tokenLogoUri={detail.logoUri}
  quoteAsset={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals }}
  explorerBase={explorerBase ?? null}
  usdPrice={{ tokenAddress: detail.tokenAddress as `0x${string}`, priceUsd: detail.priceUsd ?? null }}
/>
```
and pass `usdPrice={{ tokenAddress: detail.tokenAddress as `0x${string}`, priceUsd: detail.priceUsd ?? null }}` to the existing `SwapPanel` (V3) and `V4SwapPanel` blocks. Replace the import of `CurveTradePanel` with `CurveSwapPanel`. For the V4 block, add `logoUri` to the launch-token side only: `{ …, logoUri: detail.logoUri }` on whichever of `tokenA`/`tokenB` is the launched token (it is the side where the address equals `detail.tokenAddress`).

`swap-trigger.tsx`: change `<Dialog … title="Swap">` to `title={`${tokenA.symbol ?? 'Token'} / ${tokenB.symbol ?? 'Token'}`}` (the panel now renders its own "Swap" heading). Pass nothing else — pool pages have no USD price, so `$` stays hidden.

Delete the six old files with `git rm`.

- [ ] **Step 4: Run the whole FE suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint .`
Expected: everything passes except the two pre-existing lint findings recorded in CLAUDE.md (`launch-list.tsx`'s `<a>`-vs-`Link`, and any other already-present finding — compare against `git stash`-free baseline by checking the findings are in files this plan did not touch). Fix anything new.

- [ ] **Step 5: Commit**

```bash
git add src/trading/swap-panel-preview.tsx src/trading/swap-panel-preview.test.tsx src/features/launch/launch-detail.tsx src/features/launch/launch-detail.test.tsx src/features/pools/swap-trigger.tsx
git rm src/trading/buy-panel.tsx src/trading/buy-panel.test.tsx src/trading/sell-panel.tsx src/trading/sell-panel.test.tsx src/trading/curve-trade-panel.tsx src/trading/curve-trade-panel.test.tsx
git commit -m "feat: wire the unified swap panel into launch and pool pages

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Playwright smoke

**Files:**
- Modify: `fe/e2e/launch-detail.spec.ts`

- [ ] **Step 1: Check what the mock launch renders**

Read `fe/e2e/mock-api.ts`: find whether the mock launch detail has `tokenDecimals`/`quoteAsset.decimals` non-null and a curve venue (the existing test "…no trade-execution controls" asserts zero `buy|sell|swap` buttons in `<main>`, which implies the trading panel is not rendered for the mock). Do not change that existing test's intent: if the panel is not rendered for the mock, add a second mock detail or mock override only if the existing fixtures already support one; otherwise limit this task to the assertions below on whatever the mock renders.

- [ ] **Step 2: Add the assertions**

```ts
test('the trade panel never offers Limit or Buy/Sell tabs', async ({ page }) => {
  await expect(page.getByRole('tab', { name: /^limit$/i })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^(buy|sell)$/i })).toHaveCount(0);
});
```
If the mock renders the panel (Swap pill visible), also assert `await expect(page.getByText('Bonding curve').first()).toBeVisible()` and that both `Sell amount` and `Buy amount` inputs are visible. Update the existing "no trade-execution controls" test only if the panel is rendered and the `swap` flip button now trips its `/buy|sell|swap/i` regex (the flip button is named "Flip swap direction"); in that case narrow the regex to the verbs that were meant to be forbidden while the wallet is disconnected, keeping the test's stated purpose.

- [ ] **Step 3: Run**

Run: `npm run test:e2e -- launch-detail.spec.ts` (needs `npm run e2e:install` once). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/launch-detail.spec.ts
git commit -m "test: e2e smoke for the unified swap panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live verification (report, no code unless a bug is found)

**Files:** none unless a defect is found (then fix it with a test in the owning task's file).

- [ ] **Step 1:** Run `npm run dev` in `fe/` with the BE running (`be/`), open a launch whose official venue is the **active bonding curve**, connect a funded test wallet (Robinhood Chain 4663).
- [ ] **Step 2:** Record, for the three paths — native-ETH-quoted curve buy, ERC20-quoted curve buy, curve sell — whether typing in the **Buy** box fills the Sell box. For ERC20-quoted buy and sell, record whether it only works after the curve is approved (expected per spec; a revert in simulation shows "Quote unavailable"). Record the number of RPC calls and the wall-clock time from the last keystroke to the derived amount (browser devtools → Network, filter `eth_call`).
- [ ] **Step 3:** Repeat on a graduated V3 launch (expect one `quoteExactOutputSingle` call) and a graduated V4 launch / a Pools-page V4 pool (expect a short `quoteExactInputSingleV4` sequence).
- [ ] **Step 4:** Append the measured numbers and the approval finding to the spec under "Two-way quoting" (a short "Measured" paragraph), commit that doc only. If derived-input latency on the curve exceeds ~5 s, lower `SOLVER_MAX_CALLS`/widen the tolerance in `solve-input-for-output.ts` with a test, or pass an `initialGuess` from the last forward quote — report the measured numbers to the user before changing the constants.
- [ ] **Step 5:** Final check: `npx vitest run && npx tsc --noEmit && npx eslint .` in `fe/`; report any test or lint failure verbatim.

---

## Self-Review (done)

- **Spec coverage:** TradeCard/SwapShell (Task 4); two-way state, flip semantics, solver, per-venue builders, debounce/abort (Tasks 1–3); V3 single-call exact-out (Task 2, 5); V4/curve search (Task 2, 6, 7); `CurveSwapPanel` replacing Buy/Sell/CurveTrade with ported regression tests (Task 7, 8); preview (Task 8); USD line launch-token-only/hidden on pools (Tasks 4, 5–8); venue badge (Tasks 4–7); no tabs (Task 4/7/9); no backend change; e2e + full suites (Tasks 8–9); measurement and the approval-gating caveat (Task 10).
- **Placeholders:** none — the two places that say "copy verbatim from buy-panel.tsx" (submission/batch hook boilerplate) point to an existing file the engineer reads, and name exactly which parts.
- **Type consistency:** `QuoteFn`, `ReverseSolve`, `ReverseStatus`, `useSwapAmounts` field names (`sellText`, `buyTypedText`, `amountIn`, `reverseStatus`, `onSellChange`, `onBuyChange`, `flip`, `reset`), `TradeCardSide` fields, and `usdPrice` prop shape are identical across Tasks 1–8.
- **Known risk called out, not hidden:** curve reverse quotes on ERC20-quoted buy and on sell may revert in simulation until approved (same as today's forward quote); the plan surfaces this as "Quote unavailable" and verifies it live in Task 10.
