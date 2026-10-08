# Unified Swap Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Uniswap-style swap panel (Sell/Buy cards, flip arrow, both inputs editable and two-way quoted) used by the bonding curve, V3 and V4 trading venues.

**Architecture:** A presentational `TradeCard` + `SwapShell` replace the hand-rolled markup of the three panels. A shared `useSwapAmounts` hook holds "which side the user typed in" and, when that is the Buy side, derives the exact-input amount `X` via a reverse quote: V3 uses its exact-out quoter in one call; V4 and the curve use a parallel search (`solveInputForOutput`) over `eth_call` simulations. Curve simulations run as a synthetic account given the needed balance/allowance by state override (ERC20 storage slots discovered per token), and start from an exact closed-form model of the curve as a guess. Execution on every venue stays exact-input using `X`, so Permit2/approval/batching/slippage code is untouched. `BuyPanel`+`SellPanel`+`CurveTradePanel` merge into `CurveSwapPanel`.

**Quote-asset USD:** Task 5 adds `quotePriceUsd` to the launch-detail API so both cards can show a `$` line from each token's own market price (their gap is the price impact plus fees, as on Uniswap).

**Tech Stack:** Next.js (see `fe/AGENTS.md` — this Next has breaking changes; none of this plan touches routing/config), React, wagmi + viem, Tailwind, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-unified-swap-panel-design.md`

## Global Constraints

- Frontend, plus ONE additive backend field (`quotePriceUsd` on the launch detail, Task 5: no migration, no behavior change to existing fields). No change to any on-chain call shape, approval amount, quote, slippage, deadline or EIP-5792 batching behavior.
- Frontend copy is English. Code identifiers, tests, comments and filenames are English.
- `null` means unavailable, never zero: a `$` line is hidden (not `$0`) when no real USD price exists; an unsolvable reverse quote shows "Quote unavailable" and disables the action button — it never guesses.
- No `Limit` tab and no `Buy | Sell` tab bar anywhere in this work.
- The venue (curve vs. V3/V4 pool) stays visible as a badge on the panel.
- Slippage and deadline are edited only in the existing settings popover (as on Uniswap); the panel face shows just a read-only "Min received" row computed with the same `applySlippage` the submit path uses.
- Light/dark: use existing theme tokens (`bg-card`, `bg-muted`, `text-muted-foreground`, `bg-primary`, …); introduce no new color.
- Work directly on `main`. Run commands from `fe/` (Task 5: `be/`) unless stated. The working tree has MANY uncommitted changes that are not part of this plan (e.g. `be/src/api/store.ts`, `server.ts`, `fe/src/api/schema.ts`, `fe/src/features/launch/launch-detail.tsx`, `fe/src/trading/approve-or-action-button.tsx`, and several untracked files). Never `git add -A` / `git add .`. Before editing a file that `git status` shows as already modified, run `git diff <file>` and stage ONLY your own hunks (`git add -p <file>`); never commit someone else's in-progress edits. A task's commit step lists the files it owns; for an already-modified file that means "your hunks only". Untracked files you did not create (e.g. `fe/src/features/pools/swap-trigger.tsx`) are the user's work in progress — edit them only as the task says, and tell the user when a commit would add such a file.
- Every commit message ends with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

Inputs/conditions the spec implies that a user will plausibly hit; each has a pinned test in the owning task:

1. Typing a Buy amount larger than the pool/curve can deliver → Sell card shows "Quote unavailable", button reads "Quote unavailable" (disabled), no crash (Tasks 1, 4, 9, 10, 11).
2. Typing fast in the Buy box → earlier searches are aborted, only the last value's result is applied (Task 6).
3. Flipping after typing keeps the typed number on the same token and never shows a stale derived value from the old direction (Tasks 6, 9, 10, 11).
4. Clearing the box or typing `.`/`1e5`/garbage → no RPC calls, no crash, button says "Enter an amount" (Tasks 6, 8, 9).
5. Wallet disconnected → the button says "Connect" (not "Switch network") and opens the wallet dialog; the reverse quote still works (it simulates as a synthetic account); forward quote and "Min received" stay hidden as today (Tasks 4, 8, 11).
6. A token whose balance/allowance storage layout cannot be discovered (e.g. a proxy like WETH) → reverse quote unavailable, and no trade simulation is attempted (Tasks 2, 4).
7. A tiny input that the curve reverts as dust must not be read as "too large" (Task 1).
8. A launch inside its snipe-tax window or with a creator tax: the closed-form guess is too low, the simulation still finds the right input (Tasks 1, 3).
9. The quote asset has no verified USD feed, the feed read fails, or the launched token's own price is unavailable → that side's `$` line is hidden (never `$0`), the other side's still shows, and the launch detail still loads (Tasks 5, 7, 12).
10. The sold token's balance is still loading → the button must not flash "Not enough X"; it reads "Checking balance…" until the balance is known (Task 8).
11. Button ladder order: Connect → Switch network → Enter an amount / Getting quote… → Checking balance… → Not enough X → Approve → Getting quote… → Quote unavailable → Swap (Task 8's table is pinned by `trade-button-state.test.ts`).

---

### Task 1: `solveInputForOutput` (pure, parallel reverse-quote search)

**Files:**
- Create: `fe/src/trading/solve-input-for-output.ts`
- Test: `fe/src/trading/solve-input-for-output.test.ts`

**Interfaces:**
- Produces:
  - `type QuoteFn = (amountIn: bigint, signal: AbortSignal) => Promise<bigint | null>` — exact-input quote; `null` = the simulation reverted / failed.
  - `solveInputForOutput(quoteFn: QuoteFn, targetOut: bigint, options?: { signal?: AbortSignal; maxRounds?: number; initialGuess?: bigint }): Promise<bigint | null>` — the smallest-found `X` with `quoteFn(X) >= targetOut`, within 0.01% of the true minimum (or 1 raw unit); `null` if none is found, rounds run out, `targetOut <= 0n`, or `signal` aborts.
  - Constants: `SOLVER_MAX_ROUNDS = 12`, `SOLVER_WIDE_POINTS = 16`, `SOLVER_REFINE_POINTS = 8`.

**Algorithm (the contract the tests pin):** each *round* probes a set of inputs **in parallel** (one network round-trip, ~380 ms on the public RPC), then narrows the bracket:
- A probe result is **ENOUGH** (`q >= target`), **SMALL** (`q < target`), or `null`. A `null` is **DUST** (too small — e.g. a curve reverts tiny trades with a zero-output error) unless a smaller input already returned non-null, in which case it is **TOO_LARGE** (over capacity / over balance). Nulls are classified by comparing against the smallest known non-null input, never by round order.
- Round 0 grid: with `initialGuess` — `guess × [0.25, 0.5, 0.9, 0.99, 1, 1.01, 1.1, 2, 4]`; without — a wide grid `1e6 × 16^k`, `k = 0..15` (16 points, covering 1e6…1e24 in one round).
- `lo` = largest input known too small (SMALL or DUST), `best` = smallest ENOUGH input, `tooLarge` = smallest TOO_LARGE input, `hi = min(best, tooLarge)`.
- If no `hi` yet: probe the next wide grid starting at `lo × 16`. Two rounds in which every probe returned `null` → give up (`null`); `lo × 16 > 2^128` → give up.
- Otherwise refine: probe 8 evenly spaced interior points of `(lo, hi)` (the bracket shrinks ~9× per round). Stop when `hi − lo <= max(1, lo / 10_000)`; return `best` (`null` if the bracket closed on TOO_LARGE with no ENOUGH).

- [ ] **Step 1: Write the failing tests**

```ts
// fe/src/trading/solve-input-for-output.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SOLVER_MAX_ROUNDS, SOLVER_WIDE_POINTS, solveInputForOutput, type QuoteFn } from './solve-input-for-output';

const never = new AbortController().signal;
const within = (x: bigint, trueMin: bigint) => x >= trueMin && x <= trueMin + trueMin / 10_000n + 1n;

const linear: QuoteFn = async (x) => x * 3n;
const convex: QuoteFn = async (x) => (x * x) / 10n ** 18n;
const capped = (capacity: bigint): QuoteFn => async (x) => (x > capacity ? null : x * 3n);
// reverts for dust (below a minimum trade size), like the real curve's zero-output revert
const dust = (min: bigint): QuoteFn => async (x) => (x < min ? null : x / 2n);

describe('solveInputForOutput', () => {
  it('solves a linear quote within 0.01%', async () => {
    const x = await solveInputForOutput(linear, 3n * 10n ** 18n);
    expect(x).not.toBeNull();
    expect(await linear(x!, never)).toBeGreaterThanOrEqual(3n * 10n ** 18n);
    expect(within(x!, 10n ** 18n)).toBe(true);
  });

  it('solves a convex (curve-like) quote', async () => {
    const x = await solveInputForOutput(convex, 4n * 10n ** 18n); // x^2/1e18 = 4e18 -> x = 2e18
    expect(await convex(x!, never)).toBeGreaterThanOrEqual(4n * 10n ** 18n);
    expect(within(x!, 2n * 10n ** 18n)).toBe(true);
  });

  it('solves a tiny target down to the exact raw unit', async () => {
    const x = await solveInputForOutput(linear, 1n);
    expect(x).toBe(1n);
  });

  it('does not mistake a dust revert for "too large"', async () => {
    const quote = dust(1_000_000_000n);
    const x = await solveInputForOutput(quote, 500_000_000n); // true minimum input = 1e9
    expect(x).not.toBeNull();
    expect(await quote(x!, never)).toBeGreaterThanOrEqual(500_000_000n);
    expect(within(x!, 1_000_000_000n)).toBe(true);
  });

  it('treats a null above capacity as TOO_LARGE and still solves a reachable target', async () => {
    const quote = capped(5n * 10n ** 18n);
    const x = await solveInputForOutput(quote, 12n * 10n ** 18n); // needs 4e18
    expect(x).not.toBeNull();
    expect(await quote(x!, never)).toBeGreaterThanOrEqual(12n * 10n ** 18n);
    expect(within(x!, 4n * 10n ** 18n)).toBe(true);
  });

  it('returns null when the target exceeds capacity', async () => {
    expect(await solveInputForOutput(capped(5n * 10n ** 18n), 18n * 10n ** 18n)).toBeNull();
  });

  it('gives up quickly (<= 2 wide rounds) when every probe fails', async () => {
    const fn = vi.fn<QuoteFn>(async () => null);
    expect(await solveInputForOutput(fn, 1000n)).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2 * SOLVER_WIDE_POINTS);
  });

  it('treats a throwing quote function as a failed probe', async () => {
    expect(await solveInputForOutput(async () => { throw new Error('rpc down'); }, 1000n)).toBeNull();
  });

  it('returns null for a zero or negative target without calling the quote function', async () => {
    const fn = vi.fn<QuoteFn>(async (x) => x);
    expect(await solveInputForOutput(fn, 0n)).toBeNull();
    expect(await solveInputForOutput(fn, -5n)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops after maxRounds', async () => {
    const fn = vi.fn<QuoteFn>(async () => 1n); // always just under the target
    expect(await solveInputForOutput(fn, 2n, { maxRounds: 3 })).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3 * SOLVER_WIDE_POINTS);
    expect(SOLVER_MAX_ROUNDS).toBe(12);
  });

  it('returns null when the signal aborts, after at most one round of calls', async () => {
    const controller = new AbortController();
    const fn = vi.fn<QuoteFn>(async (x) => { controller.abort(); return x * 3n; });
    expect(await solveInputForOutput(fn, 3n * 10n ** 18n, { signal: controller.signal })).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(SOLVER_WIDE_POINTS);
  });

  it('probes in parallel: a round has several quotes in flight at once, never more than the grid size', async () => {
    let inFlight = 0;
    let peak = 0;
    const quote: QuoteFn = async (x) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return x * 3n;
    };
    await solveInputForOutput(quote, 3n * 10n ** 18n);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SOLVER_WIDE_POINTS);
  });

  it('an accurate initialGuess solves in few calls', async () => {
    const fn = vi.fn<QuoteFn>(linear);
    const x = await solveInputForOutput(fn, 3n * 10n ** 18n, { initialGuess: 10n ** 18n });
    expect(within(x!, 10n ** 18n)).toBe(true);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(9 + 8 * 4); // guess round + <= 4 refine rounds
  });

  it('a badly wrong initialGuess (100x too small, e.g. a snipe-tax window) still solves', async () => {
    const x = await solveInputForOutput(linear, 3n * 10n ** 18n, { initialGuess: 10n ** 16n });
    expect(within(x!, 10n ** 18n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/trading/solve-input-for-output.test.ts`
Expected: FAIL — cannot resolve `./solve-input-for-output`.

- [ ] **Step 3: Implement**

```ts
// fe/src/trading/solve-input-for-output.ts

// Exact-input quote: how much comes out for `amountIn` going in. `null` = the simulation reverted.
export type QuoteFn = (amountIn: bigint, signal: AbortSignal) => Promise<bigint | null>;

export const SOLVER_MAX_ROUNDS = 12;
export const SOLVER_WIDE_POINTS = 16;
export const SOLVER_REFINE_POINTS = 8;
const WIDE_FACTOR = 16n;
const MAX_INPUT = 1n << 128n; // far above any real token amount
const DEFAULT_START = 1_000_000n;
const GUESS_MULTIPLIERS_BPS = [2500n, 5000n, 9000n, 9900n, 10000n, 10100n, 11000n, 20000n, 40000n];

export interface SolveOptions {
  signal?: AbortSignal;
  maxRounds?: number;
  initialGuess?: bigint;
}

function wideGrid(start: bigint): bigint[] {
  const points: bigint[] = [];
  let x = start;
  for (let i = 0; i < SOLVER_WIDE_POINTS; i += 1) { points.push(x); x *= WIDE_FACTOR; }
  return points;
}

// Inverts a monotonic exact-input quote: finds (approximately) the smallest X with
// quoteFn(X) >= targetOut, so a swap executed as exact-input with X yields at least targetOut
// before slippage. Execution never changes — this only derives X for the Sell card when the user
// typed in the Buy card. Returns null (never a guess) when no X is found.
export async function solveInputForOutput(
  quoteFn: QuoteFn,
  targetOut: bigint,
  options: SolveOptions = {},
): Promise<bigint | null> {
  if (targetOut <= 0n) return null;
  const maxRounds = options.maxRounds ?? SOLVER_MAX_ROUNDS;
  const signal = options.signal ?? new AbortController().signal;

  let lo = 0n; // largest input known too small (SMALL or DUST)
  let best: bigint | null = null; // smallest input known ENOUGH
  let tooLarge: bigint | null = null; // smallest input that reverted although a smaller one succeeded
  let lowestNonNull: bigint | null = null;
  let allNullRounds = 0;

  let points: bigint[] = options.initialGuess && options.initialGuess > 0n
    ? GUESS_MULTIPLIERS_BPS.map((m) => (options.initialGuess as bigint * m) / 10_000n)
    : wideGrid(DEFAULT_START);

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal.aborted) return null;
    const unique = [...new Set(points)].filter((p) => p > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (unique.length === 0) return null;
    const results = await Promise.all(unique.map(async (x) => {
      try { return await quoteFn(x, signal); } catch { return null; }
    }));
    if (signal.aborted) return null;

    // Classify ascending: a null is TOO_LARGE only if a smaller input is known to succeed.
    for (let i = 0; i < unique.length; i += 1) {
      const x = unique[i];
      const q = results[i];
      if (q === null) {
        if (lowestNonNull !== null && lowestNonNull < x) {
          if (tooLarge === null || x < tooLarge) tooLarge = x;
        } else if (x > lo) {
          lo = x; // DUST: too small
        }
        continue;
      }
      if (lowestNonNull === null || x < lowestNonNull) lowestNonNull = x;
      if (q >= targetOut) {
        if (best === null || x < best) best = x;
      } else if (x > lo) {
        lo = x;
      }
    }

    if (lowestNonNull === null) {
      allNullRounds += 1;
      if (allNullRounds >= 2) return null;
    }

    const candidates = [best, tooLarge].filter((v): v is bigint => v !== null);
    const hi = candidates.length === 0 ? null : candidates.reduce((a, b) => (a < b ? a : b));

    if (hi === null) {
      const next = lo === 0n ? DEFAULT_START : lo * WIDE_FACTOR;
      if (next > MAX_INPUT) return null;
      points = wideGrid(next);
      continue;
    }

    const width = hi - lo;
    const tolerance = lo / 10_000n > 1n ? lo / 10_000n : 1n;
    if (width <= tolerance) return best;

    const divisor = BigInt(SOLVER_REFINE_POINTS + 1);
    points = Array.from({ length: SOLVER_REFINE_POINTS }, (_, j) => lo + (width * BigInt(j + 1)) / divisor);
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/trading/solve-input-for-output.test.ts`
Expected: PASS (14 tests). If "tiny target" ends at a value above 1, the refine loop stopped on the relative tolerance too early — it must keep refining while `lo === 0` (tolerance is 1 raw unit then); fix the loop, not the test. If the "capacity" tests fail, re-check that a `null` below the smallest known non-null is classified DUST and one above it TOO_LARGE.

- [ ] **Step 5: Commit**

```bash
git add src/trading/solve-input-for-output.ts src/trading/solve-input-for-output.test.ts
git commit -m "feat: add parallel reverse-quote solver for the two-way swap panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: ERC20 storage-slot discovery and simulation state overrides

Why: `curve.buy` (ERC20-quoted) and `curve.sell` revert in `eth_call` with `InsufficientAllowance()` / `ERC20InsufficientBalance` until the account has balance and has approved the curve. `eth_call` accepts a *state override* — "pretend this storage slot holds this value for this run only" — so the reverse search can run as a synthetic account that holds and has approved plenty, independent of the user's wallet. That needs the token's balance/allowance storage slots, which differ per token; they are discovered by writing a probe value into a candidate slot and reading it back through the token's own `balanceOf`/`allowance`. Verified live on chain 4663 (2026-10-09): USDG balance@1/allowance@3; Pons launch tokens balance@0/allowance@1; stock tokens (NVDA, TSLA, SPCX, GME, SPY) use OpenZeppelin-5 namespaced storage (`0x52c63247…ace00`, allowance at `+1`). WETH (an EIP-1967 proxy) could not be discovered — it is never a curve quote asset (all WETH-quoted launches are V1 pools).

**Files:**
- Create: `fe/src/trading/erc20-state-override.ts`
- Create: `fe/src/trading/test-support/fake-call-client.ts` (shared test helper)
- Test: `fe/src/trading/erc20-state-override.test.ts`

**Interfaces:**
- Produces:
  - `SIMULATION_ACCOUNT: Address = '0x00000000000000000000000000000000000a11ce'`
  - `MAX_UINT256: bigint`
  - `interface CallClient { call(args: { to: Address; data: Hex; account?: Address; value?: bigint; stateOverride?: StateOverride }): Promise<{ data?: Hex }> }` (structural; wagmi's `usePublicClient()` result satisfies it)
  - `type BalanceSlot = (owner: Address) => Hex`, `type AllowanceSlot = (owner: Address, spender: Address) => Hex`
  - `balanceSlotAt(base: bigint): BalanceSlot`, `allowanceSlotAt(base: bigint): AllowanceSlot` (mapping layouts; exported for tests)
  - `interface Erc20Layouts { balanceSlot: BalanceSlot | null; allowanceSlot: AllowanceSlot | null }`
  - `discoverErc20Layouts(client: CallClient, token: Address): Promise<Erc20Layouts>` — cached per token address; `clearErc20LayoutCache(): void` (tests)
  - `spendStateOverride({ layouts, token, owner, spender }): StateOverride | null` — balance and allowance(owner → spender) set to `MAX_UINT256`; `null` if either slot is unknown
  - `nativeBalanceOverride(owner: Address): StateOverride` — gives `owner` 10^30 wei
- Test-support produces: `fake-call-client.ts` exports `encodeResult(abi, functionName, value): { data: Hex }` and `makeFakeClient(handler): CallClient & { call: Mock }` where `handler(req: { to: Address; data: Hex; value?: bigint; account?: Address; stateOverride?: StateOverride }): { data?: Hex } | Promise<{ data?: Hex }>` (a handler that throws simulates a revert).

- [ ] **Step 1: Create the shared test helper**

```ts
// fe/src/trading/test-support/fake-call-client.ts
import { vi } from 'vitest';
import { encodeFunctionResult, type Abi, type Address, type Hex, type StateOverride } from 'viem';
import type { CallClient } from '../erc20-state-override';

export interface FakeCallRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  account?: Address;
  stateOverride?: StateOverride;
}

export function encodeResult(abi: Abi, functionName: string, value: any): { data: Hex } {
  return { data: encodeFunctionResult({ abi, functionName, result: value } as any) };
}

export function makeFakeClient(handler: (request: FakeCallRequest) => { data?: Hex } | Promise<{ data?: Hex }>) {
  const call = vi.fn(async (request: FakeCallRequest) => handler(request));
  return { call } as unknown as CallClient & { call: typeof call };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// fe/src/trading/erc20-state-override.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import {
  MAX_UINT256, SIMULATION_ACCOUNT, allowanceSlotAt, balanceSlotAt, clearErc20LayoutCache,
  discoverErc20Layouts, nativeBalanceOverride, spendStateOverride,
} from './erc20-state-override';
import { encodeResult, makeFakeClient, type FakeCallRequest } from './test-support/fake-call-client';

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const token = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;

// A fake token whose storage lives at the given mapping bases (balance@b, allowance@a).
function fakeToken(balanceBase: bigint, allowanceBase: bigint) {
  return makeFakeClient((req: FakeCallRequest) => {
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: req.data });
    const diff = req.stateOverride?.find((o) => o.address.toLowerCase() === token)?.stateDiff ?? [];
    const read = (slot: Hex): bigint => {
      const hit = diff.find((d) => d.slot.toLowerCase() === slot.toLowerCase());
      return hit ? BigInt(hit.value) : 0n;
    };
    if (functionName === 'balanceOf') return encodeResult(erc20, 'balanceOf', read(balanceSlotAt(balanceBase)(args![0] as Address)));
    return encodeResult(erc20, 'allowance', read(allowanceSlotAt(allowanceBase)(args![0] as Address, args![1] as Address)));
  });
}

beforeEach(() => clearErc20LayoutCache());

describe('discoverErc20Layouts', () => {
  it('finds a USDG-style layout (balance@1, allowance@3)', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(1n, 3n), token);
    expect(layouts.balanceSlot).not.toBeNull();
    expect(layouts.allowanceSlot).not.toBeNull();
    const owner = SIMULATION_ACCOUNT;
    expect(layouts.balanceSlot!(owner)).toBe(balanceSlotAt(1n)(owner));
    expect(layouts.allowanceSlot!(owner, token)).toBe(allowanceSlotAt(3n)(owner, token));
  });

  it('finds a Solmate-style layout (balance@0, allowance@1)', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(0n, 1n), token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(0n)(SIMULATION_ACCOUNT));
    expect(layouts.allowanceSlot!(SIMULATION_ACCOUNT, token)).toBe(allowanceSlotAt(1n)(SIMULATION_ACCOUNT, token));
  });

  it('finds an OpenZeppelin-5 namespaced layout', async () => {
    const ns = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00');
    const layouts = await discoverErc20Layouts(fakeToken(ns, ns + 1n), token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(ns)(SIMULATION_ACCOUNT));
    expect(layouts.allowanceSlot!(SIMULATION_ACCOUNT, token)).toBe(allowanceSlotAt(ns + 1n)(SIMULATION_ACCOUNT, token));
  });

  it('finds a layout that only the second probing stage covers (base 7)', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(7n, 8n), token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(7n)(SIMULATION_ACCOUNT));
  });

  it('reports null slots for an unsupported layout instead of guessing', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(500n, 501n), token);
    expect(layouts).toEqual({ balanceSlot: null, allowanceSlot: null });
  });

  it('treats a failing node as "not found"', async () => {
    const client = makeFakeClient(() => { throw new Error('rpc down'); });
    expect(await discoverErc20Layouts(client, token)).toEqual({ balanceSlot: null, allowanceSlot: null });
  });

  it('caches per token: a second call makes no more RPC calls', async () => {
    const client = fakeToken(1n, 3n);
    await discoverErc20Layouts(client, token);
    const calls = client.call.mock.calls.length;
    await discoverErc20Layouts(client, token.toUpperCase().replace('0X', '0x') as Address);
    expect(client.call.mock.calls.length).toBe(calls);
  });
});

describe('spendStateOverride', () => {
  it('sets the owner balance and the owner→spender allowance to max on the token', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(1n, 3n), token);
    const spender = '0x4444444444444444444444444444444444444444' as Address;
    const override = spendStateOverride({ layouts, token, owner: SIMULATION_ACCOUNT, spender });
    expect(override).toHaveLength(1);
    expect(override![0].address).toBe(token);
    const slots = override![0].stateDiff!.map((d) => d.slot);
    expect(slots).toContain(balanceSlotAt(1n)(SIMULATION_ACCOUNT));
    expect(slots).toContain(allowanceSlotAt(3n)(SIMULATION_ACCOUNT, spender));
    for (const d of override![0].stateDiff!) expect(BigInt(d.value)).toBe(MAX_UINT256);
  });

  it('returns null when either slot is unknown', () => {
    expect(spendStateOverride({ layouts: { balanceSlot: null, allowanceSlot: null }, token, owner: SIMULATION_ACCOUNT, spender: token })).toBeNull();
    expect(spendStateOverride({ layouts: { balanceSlot: balanceSlotAt(1n), allowanceSlot: null }, token, owner: SIMULATION_ACCOUNT, spender: token })).toBeNull();
  });
});

describe('nativeBalanceOverride', () => {
  it('gives the owner a large native balance', () => {
    const override = nativeBalanceOverride(SIMULATION_ACCOUNT);
    expect(override).toEqual([{ address: SIMULATION_ACCOUNT, balance: 10n ** 30n }]);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/trading/erc20-state-override.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
// fe/src/trading/erc20-state-override.ts
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, pad, parseAbi,
  type Address, type Hex, type StateOverride,
} from 'viem';

// A fixed address used only inside eth_call simulations: it is given a balance and an allowance
// by state override, so the reverse quote never depends on the connected wallet's own state.
export const SIMULATION_ACCOUNT: Address = '0x00000000000000000000000000000000000a11ce';
export const MAX_UINT256 = (1n << 256n) - 1n;

export interface CallClient {
  call: (args: { to: Address; data: Hex; account?: Address; value?: bigint; stateOverride?: StateOverride }) => Promise<{ data?: Hex }>;
}

const erc20ProbeAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);

const PROBE_SPENDER: Address = '0x00000000000000000000000000000000000b0b00';
const PROBE_VALUE = 4_294_967_295n;
// OpenZeppelin 5 keeps ERC20 state at a fixed ERC-7201 namespaced slot: _balances at +0, _allowances at +1.
const OZ5_ERC20_STORAGE = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00');
const STAGE_ONE = [OZ5_ERC20_STORAGE, 0n, 1n, 2n, 3n];
const STAGE_TWO = [4n, 5n, 6n, 7n, 8n, 9n];

export type BalanceSlot = (owner: Address) => Hex;
export type AllowanceSlot = (owner: Address, spender: Address) => Hex;
export interface Erc20Layouts {
  balanceSlot: BalanceSlot | null;
  allowanceSlot: AllowanceSlot | null;
}

const mappingSlot = (key: Address, base: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, base]));

// mapping(address => uint256) _balances at `base`
export const balanceSlotAt = (base: bigint): BalanceSlot => (owner) => mappingSlot(owner, base);
// mapping(address => mapping(address => uint256)) _allowances at `base`
export const allowanceSlotAt = (base: bigint): AllowanceSlot => (owner, spender) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [spender, BigInt(mappingSlot(owner, base))]));

const word = (value: bigint): Hex => pad(numberToHex(value), { size: 32 });

// Write a probe value into a candidate slot and read it back through the token's OWN view
// function: if the view returns the probe, that slot is where the token keeps this value.
async function probe(
  client: CallClient,
  token: Address,
  functionName: 'balanceOf' | 'allowance',
  slot: Hex,
): Promise<boolean> {
  try {
    const data = functionName === 'balanceOf'
      ? encodeFunctionData({ abi: erc20ProbeAbi, functionName, args: [SIMULATION_ACCOUNT] })
      : encodeFunctionData({ abi: erc20ProbeAbi, functionName, args: [SIMULATION_ACCOUNT, PROBE_SPENDER] });
    const { data: out } = await client.call({
      to: token,
      data,
      stateOverride: [{ address: token, stateDiff: [{ slot, value: word(PROBE_VALUE) }] }],
    });
    if (!out) return false;
    return decodeFunctionResult({ abi: erc20ProbeAbi, functionName, data: out }) === PROBE_VALUE;
  } catch {
    return false;
  }
}

async function discover(client: CallClient, token: Address): Promise<Erc20Layouts> {
  let balanceSlot: BalanceSlot | null = null;
  let allowanceSlot: AllowanceSlot | null = null;
  for (const stage of [STAGE_ONE, STAGE_TWO]) {
    const [balanceHits, allowanceHits] = await Promise.all([
      balanceSlot
        ? Promise.resolve<boolean[]>([])
        : Promise.all(stage.map((base) => probe(client, token, 'balanceOf', balanceSlotAt(base)(SIMULATION_ACCOUNT)))),
      allowanceSlot
        ? Promise.resolve<boolean[]>([])
        : Promise.all(stage.map((base) => probe(client, token, 'allowance', allowanceSlotAt(base === OZ5_ERC20_STORAGE ? base + 1n : base)(SIMULATION_ACCOUNT, PROBE_SPENDER)))),
    ]);
    const balanceIndex = balanceHits.indexOf(true);
    if (balanceIndex !== -1) balanceSlot = balanceSlotAt(stage[balanceIndex]);
    const allowanceIndex = allowanceHits.indexOf(true);
    if (allowanceIndex !== -1) {
      const base = stage[allowanceIndex];
      allowanceSlot = allowanceSlotAt(base === OZ5_ERC20_STORAGE ? base + 1n : base);
    }
    if (balanceSlot && allowanceSlot) break;
  }
  return { balanceSlot, allowanceSlot };
}

// One chain only (Robinhood Chain, 4663), so the token address alone is a sufficient cache key.
const cache = new Map<string, Promise<Erc20Layouts>>();
export function discoverErc20Layouts(client: CallClient, token: Address): Promise<Erc20Layouts> {
  const key = token.toLowerCase();
  let hit = cache.get(key);
  if (!hit) {
    hit = discover(client, token);
    cache.set(key, hit);
  }
  return hit;
}
export function clearErc20LayoutCache(): void { cache.clear(); }

export function spendStateOverride(
  { layouts, token, owner, spender }: { layouts: Erc20Layouts; token: Address; owner: Address; spender: Address },
): StateOverride | null {
  if (!layouts.balanceSlot || !layouts.allowanceSlot) return null;
  return [{
    address: token,
    stateDiff: [
      { slot: layouts.balanceSlot(owner), value: word(MAX_UINT256) },
      { slot: layouts.allowanceSlot(owner, spender), value: word(MAX_UINT256) },
    ],
  }];
}

export function nativeBalanceOverride(owner: Address): StateOverride {
  return [{ address: owner, balance: 10n ** 30n }];
}
```

Note: the cache key lowercases the address, so the "second call" test (upper-cased input) must hit the cache. A failed discovery is also cached for the session (a node outage at that moment means "unavailable" until reload) — acceptable; do not add retry logic.

- [ ] **Step 5: Run to verify pass, typecheck, lint** — `npx vitest run src/trading/erc20-state-override.test.ts && npx tsc --noEmit && npx eslint src/trading/erc20-state-override.ts src/trading/test-support/fake-call-client.ts`. Expected: PASS. If `tsc` complains that wagmi's client does not satisfy `CallClient` it will show up in Task 4/7+; the `StateOverride` type must come from `viem` — confirm the import resolves in the installed viem version.

- [ ] **Step 6: Commit**

```bash
git add src/trading/erc20-state-override.ts src/trading/erc20-state-override.test.ts src/trading/test-support/fake-call-client.ts
git commit -m "feat: discover ERC20 storage slots and build simulation state overrides

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Curve closed-form model (initial guess for the search)

Why: the curve is a constant-product curve with virtual reserves and a fee; the formula below reproduces the real `buy`/`sell` simulations **exactly** (verified on chain 4663, 2026-10-09, curve `0x4075be45…f948`, reserves read at the same block: `buy` 1e15 / 5e15 / 1e17 wei → 588905085539402016855496 / 2937605347464235929523175 / 55646155927117960995515549 tokens; `sell` 1e18 / 1e21 / 1e15 tokens → 1663294851 / 1663293189632 / 1663295 wei). It is used **only** as the search's `initialGuess`: during a launch's snipe-tax window or with a creator tax the real output is lower, so the guess is off — the simulation-based search still finds the right answer (see Task 1's "badly wrong initialGuess" test). The guess never replaces the simulation.

**Files:**
- Modify: `fe/src/trading/curveAbi.ts` (add `curveStateAbi`)
- Create: `fe/src/trading/curve-guess.ts`
- Test: `fe/src/trading/curve-guess.test.ts`

**Interfaces:**
- Consumes: `CallClient` (Task 2).
- Produces:
  - `interface CurveState { quoteReserve: bigint; tokenReserve: bigint; feeBps: bigint }`
  - `curveBuyOutput(state, amountIn): bigint`, `curveSellOutput(state, tokensIn): bigint`
  - `guessBuyInput(state, targetTokensOut): bigint | null`, `guessSellInput(state, targetQuoteOut): bigint | null`
  - `readCurveState(client: CallClient, curveAddress: Address): Promise<CurveState | null>`

- [ ] **Step 1: Add the ABI**

In `fe/src/trading/curveAbi.ts` append:

```ts
// Read-only curve state used to compute a starting guess for the reverse quote. quoteReserve()
// and tokenReserve() are the virtual reserves (they equal getReserves()'s two values on chain 4663).
export const curveStateAbi = parseAbi([
  'function quoteReserve() view returns (uint256)',
  'function tokenReserve() view returns (uint256)',
  'function feeBps() view returns (uint256)',
]);
```

- [ ] **Step 2: Write the failing tests**

```ts
// fe/src/trading/curve-guess.test.ts
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { curveStateAbi } from './curveAbi';
import {
  curveBuyOutput, curveSellOutput, guessBuyInput, guessSellInput, readCurveState, type CurveState,
} from './curve-guess';
import { decodeFunctionData } from 'viem';
import { encodeResult, makeFakeClient } from './test-support/fake-call-client';

// Reserves and fee read from the live OBUL curve on chain 4663; the expected outputs below are the
// real eth_call simulation results at that same state (see the task intro).
const live: CurveState = { quoteReserve: 1680047904858931814n, tokenReserve: 999971486016087261842747212n, feeBps: 100n };

describe('curve closed-form model matches the live simulations exactly', () => {
  it.each([
    [10n ** 15n, 588905085539402016855496n],
    [5n * 10n ** 15n, 2937605347464235929523175n],
    [10n ** 17n, 55646155927117960995515549n],
  ])('buy %s -> %s', (amountIn, expected) => {
    expect(curveBuyOutput(live, amountIn)).toBe(expected);
  });

  it.each([
    [10n ** 18n, 1663294851n],
    [10n ** 21n, 1663293189632n],
    [10n ** 15n, 1663295n],
  ])('sell %s -> %s', (tokensIn, expected) => {
    expect(curveSellOutput(live, tokensIn)).toBe(expected);
  });
});

describe('guesses invert the model closely', () => {
  it('guessBuyInput lands within 0.01% of the real input', () => {
    const g = guessBuyInput(live, 588905085539402016855496n)!;
    expect(Number(g - 10n ** 15n) / 1e15).toBeLessThan(1e-4);
    expect(Number(10n ** 15n - g) / 1e15).toBeLessThan(1e-4);
  });
  it('guessSellInput lands within 0.01% of the real input', () => {
    const g = guessSellInput(live, 1663294851n)!;
    expect(Math.abs(Number(g - 10n ** 18n)) / 1e18).toBeLessThan(1e-4);
  });
  it('returns null (no guess) for impossible targets', () => {
    expect(guessBuyInput(live, 0n)).toBeNull();
    expect(guessBuyInput(live, live.tokenReserve)).toBeNull(); // cannot buy the whole reserve
    expect(guessBuyInput({ ...live, feeBps: 10_000n }, 1n)).toBeNull();
    expect(guessSellInput(live, 0n)).toBeNull();
    expect(guessSellInput(live, live.quoteReserve)).toBeNull(); // cannot drain the quote reserve
  });
});

describe('readCurveState', () => {
  const curve = '0x4444444444444444444444444444444444444444' as Address;
  it('reads the reserves and the fee', async () => {
    const client = makeFakeClient(({ data }) => {
      const { functionName } = decodeFunctionData({ abi: curveStateAbi, data });
      const value = functionName === 'quoteReserve' ? live.quoteReserve : functionName === 'tokenReserve' ? live.tokenReserve : live.feeBps;
      return encodeResult(curveStateAbi, functionName, value);
    });
    expect(await readCurveState(client, curve)).toEqual(live);
  });
  it('returns null when any read fails', async () => {
    const client = makeFakeClient(() => { throw new Error('revert'); });
    expect(await readCurveState(client, curve)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/trading/curve-guess.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
// fe/src/trading/curve-guess.ts
import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem';
import { curveStateAbi } from './curveAbi';
import type { CallClient } from './erc20-state-override';

// Constant-product curve with virtual reserves and a fee. Buy: the fee comes off the quote input;
// sell: the fee comes off the quote output, floored. Reproduces the real simulations exactly when
// no snipe tax / creator tax applies — which is why it is only ever a starting GUESS: the
// simulation is always the source of truth.
export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  feeBps: bigint;
}

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function curveBuyOutput(state: CurveState, amountIn: bigint): bigint {
  const net = (amountIn * (BPS - state.feeBps)) / BPS;
  return (state.tokenReserve * net) / (state.quoteReserve + net);
}

export function curveSellOutput(state: CurveState, tokensIn: bigint): bigint {
  const gross = (state.quoteReserve * tokensIn) / (state.tokenReserve + tokensIn);
  return gross - (gross * state.feeBps) / BPS;
}

// Quote-asset input that should buy `targetTokensOut` tokens.
export function guessBuyInput(state: CurveState, targetTokensOut: bigint): bigint | null {
  if (targetTokensOut <= 0n || targetTokensOut >= state.tokenReserve || state.feeBps >= BPS) return null;
  const net = ceilDiv(state.quoteReserve * targetTokensOut, state.tokenReserve - targetTokensOut);
  return ceilDiv(net * BPS, BPS - state.feeBps);
}

// Token input that should sell for `targetQuoteOut` of the quote asset (after the fee).
export function guessSellInput(state: CurveState, targetQuoteOut: bigint): bigint | null {
  if (targetQuoteOut <= 0n || state.feeBps >= BPS) return null;
  const gross = ceilDiv(targetQuoteOut * BPS, BPS - state.feeBps);
  if (gross >= state.quoteReserve) return null;
  return ceilDiv(state.tokenReserve * gross, state.quoteReserve - gross);
}

export async function readCurveState(client: CallClient, curveAddress: Address): Promise<CurveState | null> {
  const read = async (functionName: 'quoteReserve' | 'tokenReserve' | 'feeBps'): Promise<bigint> => {
    const { data } = await client.call({ to: curveAddress, data: encodeFunctionData({ abi: curveStateAbi, functionName }) });
    if (!data) throw new Error('empty result');
    return decodeFunctionResult({ abi: curveStateAbi, functionName, data });
  };
  try {
    const [quoteReserve, tokenReserve, feeBps] = await Promise.all([read('quoteReserve'), read('tokenReserve'), read('feeBps')]);
    return { quoteReserve, tokenReserve, feeBps };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run to verify pass** — `npx vitest run src/trading/curve-guess.test.ts && npx tsc --noEmit`. Expected: PASS. If an exact-output assertion fails, do NOT adjust the expected numbers — they are real chain results; fix the rounding (buy: `net = floor(in·(10000−fee)/10000)`; sell: `fee = floor(gross·fee/10000)`).

- [ ] **Step 6: Commit**

```bash
git add src/trading/curveAbi.ts src/trading/curve-guess.ts src/trading/curve-guess.test.ts
git commit -m "feat: add curve closed-form model used as the reverse-quote starting guess

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Per-venue reverse quote builders

**Files:**
- Create: `fe/src/trading/reverse-quote.ts`
- Test: `fe/src/trading/reverse-quote.test.ts`
- Modify: `fe/src/trading/v3QuoterAbi.ts` (add `quoteExactOutputSingle`)

**Interfaces:**
- Consumes: `solveInputForOutput`, `QuoteFn` (Task 1); `CallClient`, `SIMULATION_ACCOUNT`, `discoverErc20Layouts`, `spendStateOverride`, `nativeBalanceOverride` (Task 2); `readCurveState`, `guessBuyInput`, `guessSellInput` (Task 3); `curveTradeAbi`; `v3QuoterAbi`, `V3_QUOTER_ADDRESS`; `v4QuoterAbi`, `V4_QUOTER_ADDRESS`; `V4PoolKey` from `./v4SwapEncoding`.
- Produces:
  - `type ReverseSolve = (targetOut: bigint, signal: AbortSignal) => Promise<bigint | null>`
  - `makeV3ReverseSolve(client: CallClient, { tokenIn, tokenOut, fee }): ReverseSolve` — a single `quoteExactOutputSingle` call
  - `makeV4ReverseSolve(client: CallClient, { poolKey, zeroForOne }): ReverseSolve` — parallel search over `quoteExactInputSingleV4`
  - `makeCurveReverseSolve(client: CallClient, { curveAddress, direction: 'buy' | 'sell', tokenAddress, quoteAssetAddress, isNativeQuote }): ReverseSolve` — parallel search over `buy()`/`sell()` simulated as `SIMULATION_ACCOUNT` with state overrides, started from the closed-form guess. `null` immediately (no curve calls) when the spent token's slots cannot be discovered.

- [ ] **Step 1: Add the V3 exact-out ABI entry**

In `fe/src/trading/v3QuoterAbi.ts` (verified live on chain 4663 on 2026-10-09: exact-in 1e18 token0 → 6.9668e21 token1; exact-out for 1e12 token1 → 143,432,958 token0, matching the exact-in rate):

```ts
export const v3QuoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
```

- [ ] **Step 2: Write the failing tests**

```ts
// fe/src/trading/reverse-quote.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { curveStateAbi, curveTradeAbi } from './curveAbi';
import { curveBuyOutput, curveSellOutput, type CurveState } from './curve-guess';
import {
  SIMULATION_ACCOUNT, allowanceSlotAt, balanceSlotAt, clearErc20LayoutCache,
} from './erc20-state-override';
import { makeCurveReverseSolve, makeV3ReverseSolve, makeV4ReverseSolve } from './reverse-quote';
import { V3_QUOTER_ADDRESS, v3QuoterAbi } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS, v4QuoterAbi } from './v4QuoterAbi';
import { encodeResult, makeFakeClient, type FakeCallRequest } from './test-support/fake-call-client';

const signal = new AbortController().signal;
const curve = '0x4444444444444444444444444444444444444444' as Address;
const launched = '0x2222222222222222222222222222222222222222' as Address;
const quoteToken = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const tokenOut = '0x3333333333333333333333333333333333333333' as Address;
const poolKey = { currency0: launched, currency1: tokenOut, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' as const };
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
// Live OBUL-curve state (chain 4663, 2026-10-09).
const state: CurveState = { quoteReserve: 1680047904858931814n, tokenReserve: 999971486016087261842747212n, feeBps: 100n };

beforeEach(() => clearErc20LayoutCache());

describe('makeV3ReverseSolve', () => {
  it('derives the input with ONE quoteExactOutputSingle call', async () => {
    const client = makeFakeClient((req) => {
      const { functionName, args } = decodeFunctionData({ abi: v3QuoterAbi, data: req.data });
      expect(req.to).toBe(V3_QUOTER_ADDRESS);
      expect(functionName).toBe('quoteExactOutputSingle');
      expect(args![0]).toMatchObject({ amount: 1_000_000_000_000n, fee: 10000, sqrtPriceLimitX96: 0n });
      return encodeResult(v3QuoterAbi, 'quoteExactOutputSingle', [143_432_958n, 0n, 1, 86_825n]);
    });
    const solve = makeV3ReverseSolve(client, { tokenIn: launched, tokenOut, fee: 10000 });
    expect(await solve(1_000_000_000_000n, signal)).toBe(143_432_958n);
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it('returns null when the quoter reverts', async () => {
    const solve = makeV3ReverseSolve(makeFakeClient(() => { throw new Error('revert'); }), { tokenIn: launched, tokenOut, fee: 10000 });
    expect(await solve(1n, signal)).toBeNull();
  });
});

describe('makeV4ReverseSolve', () => {
  it('searches over quoteExactInputSingleV4 and returns an input that covers the target', async () => {
    const client = makeFakeClient((req) => {
      expect(req.to).toBe(V4_QUOTER_ADDRESS);
      const { args } = decodeFunctionData({ abi: v4QuoterAbi, data: req.data });
      const exact = (args![0] as { exactAmount: bigint }).exactAmount;
      return encodeResult(v4QuoterAbi, 'quoteExactInputSingleV4', [exact * 2n, 0n]); // linear 2x
    });
    const solve = makeV4ReverseSolve(client, { poolKey, zeroForOne: true });
    const x = await solve(2_000_000_000_000_000n, signal);
    expect(x).not.toBeNull();
    expect(x! * 2n).toBeGreaterThanOrEqual(2_000_000_000_000_000n);
    expect(x!).toBeLessThanOrEqual((10n ** 15n * 10_001n) / 10_000n + 1n);
  });

  it('returns null when every simulation reverts', async () => {
    const solve = makeV4ReverseSolve(makeFakeClient(() => { throw new Error('revert'); }), { poolKey, zeroForOne: true });
    expect(await solve(1000n, signal)).toBeNull();
  });
});

// A fake chain with: the curve (state above), and a USDG-style token (balance@1, allowance@3).
function curveWorld(options: { quoteBalanceBase?: bigint; native?: boolean; stateReadFails?: boolean } = {}) {
  const balanceBase = options.quoteBalanceBase ?? 1n;
  const trades: FakeCallRequest[] = [];
  const client = makeFakeClient((req) => {
    if (req.to.toLowerCase() === curve) {
      const stateCall = (() => { try { return decodeFunctionData({ abi: curveStateAbi, data: req.data }); } catch { return null; } })();
      if (stateCall) {
        if (options.stateReadFails) throw new Error('state read failed');
        const v = stateCall.functionName === 'quoteReserve' ? state.quoteReserve : stateCall.functionName === 'tokenReserve' ? state.tokenReserve : state.feeBps;
        return encodeResult(curveStateAbi, stateCall.functionName, v);
      }
      trades.push(req);
      const { functionName, args } = decodeFunctionData({ abi: curveTradeAbi, data: req.data });
      const amount = args![0] as bigint;
      const diff = req.stateOverride?.flatMap((o) => o.stateDiff ?? []) ?? [];
      const has = (slot: Hex) => diff.some((d) => d.slot.toLowerCase() === slot.toLowerCase() && BigInt(d.value) >= amount);
      if (functionName === 'buy') {
        if (options.native) { if (!(req.value === amount && (req.stateOverride?.[0]?.balance ?? 0n) >= amount)) throw new Error('insufficient ETH'); }
        else if (!has(balanceSlotAt(1n)(SIMULATION_ACCOUNT)) || !has(allowanceSlotAt(3n)(SIMULATION_ACCOUNT, curve))) throw new Error('InsufficientAllowance');
        if (curveBuyOutput(state, amount) === 0n) throw new Error('ZeroOutput');
        return encodeResult(curveTradeAbi, 'buy', curveBuyOutput(state, amount));
      }
      if (!has(balanceSlotAt(0n)(SIMULATION_ACCOUNT)) || !has(allowanceSlotAt(1n)(SIMULATION_ACCOUNT, curve))) throw new Error('InsufficientAllowance');
      if (amount > 5n * 10n ** 22n) throw new Error('underflow'); // cannot sell more than has been sold
      const out = curveSellOutput(state, amount);
      if (out === 0n) throw new Error('ZeroOutput'); // dust sells revert
      return encodeResult(curveTradeAbi, 'sell', out);
    }
    // token contracts: only the discovery probes reach here
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: req.data });
    const isQuote = req.to.toLowerCase() === quoteToken;
    const [bBase, aBase] = isQuote ? [balanceBase, 3n] : [0n, 1n];
    const diff = req.stateOverride?.find((o) => o.address.toLowerCase() === req.to.toLowerCase())?.stateDiff ?? [];
    const read = (slot: Hex) => { const hit = diff.find((d) => d.slot.toLowerCase() === slot.toLowerCase()); return hit ? BigInt(hit.value) : 0n; };
    return functionName === 'balanceOf'
      ? encodeResult(erc20, 'balanceOf', read(balanceSlotAt(bBase)(args![0] as Address)))
      : encodeResult(erc20, 'allowance', read(allowanceSlotAt(aBase)(args![0] as Address, args![1] as Address)));
  });
  return { client, trades };
}

describe('makeCurveReverseSolve', () => {
  it('native-ETH buy: simulates as the synthetic account with value + ETH balance override, no wallet needed', async () => {
    const { client, trades } = curveWorld({ native: true });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: '0x0000000000000000000000000000000000000000', isNativeQuote: true });
    const target = 588905085539402016855496n; // what 1e15 wei buys
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveBuyOutput(state, x!)).toBeGreaterThanOrEqual(target);
    expect(Number(x! - 10n ** 15n) / 1e15).toBeLessThan(2e-4);
    expect(trades[0].account).toBe(SIMULATION_ACCOUNT);
  });

  it('ERC20-quoted buy: overrides the quote token balance and allowance (USDG layout) so it works pre-approval', async () => {
    const { client } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    const target = 588905085539402016855496n;
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveBuyOutput(state, x!)).toBeGreaterThanOrEqual(target);
  });

  it('sell: overrides the launched token balance and allowance (Solmate layout)', async () => {
    const { client } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'sell', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    const target = 1663294851n; // what 1e18 tokens sell for
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveSellOutput(state, x!)).toBeGreaterThanOrEqual(target);
    expect(Number(x! - 10n ** 18n) / 1e18).toBeLessThan(2e-4);
  });

  it('a good closed-form guess keeps the number of simulated trades small', async () => {
    const { client, trades } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    await solve(588905085539402016855496n, signal);
    expect(trades.length).toBeLessThanOrEqual(9 + 8 * 4);
  });

  it('returns null without simulating any trade when the spent token\'s slots cannot be discovered', async () => {
    const { client, trades } = curveWorld({ quoteBalanceBase: 500n });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    expect(await solve(588905085539402016855496n, signal)).toBeNull();
    expect(trades).toHaveLength(0);
  });

  it('returns null when the target is more than has been sold (sell over capacity)', async () => {
    const { client } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'sell', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    expect(await solve(1_000_000_000_000_000_000n, signal)).toBeNull(); // 1 ETH out of a curve holding 0.0000479
  });

  it('still works when the curve state cannot be read (no guess, wide search)', async () => {
    const { client } = curveWorld({ native: true, stateReadFails: true });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: '0x0000000000000000000000000000000000000000', isNativeQuote: true });
    const target = 588905085539402016855496n;
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveBuyOutput(state, x!)).toBeGreaterThanOrEqual(target);
  });
});
```

(Dust handling is covered at the solver level in Task 1; the fake curve here also reverts zero-output trades so the dust path is exercised end to end.)

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/trading/reverse-quote.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
// fe/src/trading/reverse-quote.ts
import { decodeFunctionResult, encodeFunctionData, type Address, type StateOverride } from 'viem';
import { curveTradeAbi } from './curveAbi';
import { guessBuyInput, guessSellInput, readCurveState } from './curve-guess';
import {
  SIMULATION_ACCOUNT, discoverErc20Layouts, nativeBalanceOverride, spendStateOverride, type CallClient,
} from './erc20-state-override';
import { solveInputForOutput, type QuoteFn } from './solve-input-for-output';
import { V3_QUOTER_ADDRESS, v3QuoterAbi } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS, v4QuoterAbi } from './v4QuoterAbi';
import type { V4PoolKey } from './v4SwapEncoding';

// "Given the amount I want to receive, what exact-input amount do I need to send?" — one function
// per venue. Execution is always exact-input with the returned amount; see the spec's
// "Two-way quoting". null = no answer (revert / over capacity / RPC error) — never a guess.
export type ReverseSolve = (targetOut: bigint, signal: AbortSignal) => Promise<bigint | null>;

// V3: the deployed QuoterV2 has a real exact-output quote (verified live on chain 4663), so this
// is a single call and no search.
export function makeV3ReverseSolve(
  client: CallClient,
  { tokenIn, tokenOut, fee }: { tokenIn: Address; tokenOut: Address; fee: number },
): ReverseSolve {
  return async (targetOut) => {
    try {
      const { data } = await client.call({
        to: V3_QUOTER_ADDRESS,
        data: encodeFunctionData({
          abi: v3QuoterAbi,
          functionName: 'quoteExactOutputSingle',
          args: [{ tokenIn, tokenOut, amount: targetOut, fee, sqrtPriceLimitX96: 0n }],
        }),
      });
      if (!data) return null;
      return decodeFunctionResult({ abi: v3QuoterAbi, functionName: 'quoteExactOutputSingle', data })[0];
    } catch {
      return null;
    }
  };
}

// V4: the deployed quoter exposes only exact-input (quoteExactInputSingleV4), so invert it.
export function makeV4ReverseSolve(
  client: CallClient,
  { poolKey, zeroForOne }: { poolKey: V4PoolKey; zeroForOne: boolean },
): ReverseSolve {
  const quote: QuoteFn = async (amountIn) => {
    try {
      const { data } = await client.call({
        to: V4_QUOTER_ADDRESS,
        data: encodeFunctionData({
          abi: v4QuoterAbi,
          functionName: 'quoteExactInputSingleV4',
          args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
        }),
      });
      if (!data) return null;
      return decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingleV4', data })[0];
    } catch {
      return null;
    }
  };
  return (targetOut, signal) => solveInputForOutput(quote, targetOut, { signal });
}

export interface CurveReverseParams {
  curveAddress: Address;
  direction: 'buy' | 'sell';
  tokenAddress: Address; // the launched token
  quoteAssetAddress: Address; // ignored when isNativeQuote
  isNativeQuote: boolean;
}

// Curve: no quote or exact-output view exists, so invert the real buy()/sell() simulation — it
// already includes every fee and the time/address-dependent snipe tax. The simulation runs as a
// synthetic account that is GIVEN (state override) the balance and the curve allowance it needs,
// so it works before the user approves and without a connected wallet. If the spent token's
// storage slots cannot be discovered, there is no answer (null) and no trade is simulated.
// The search starts from the exact constant-product model as a guess (see curve-guess.ts).
export function makeCurveReverseSolve(client: CallClient, params: CurveReverseParams): ReverseSolve {
  const { curveAddress, direction, tokenAddress, quoteAssetAddress, isNativeQuote } = params;
  return async (targetOut, signal) => {
    let stateOverride: StateOverride | null;
    if (direction === 'buy' && isNativeQuote) {
      stateOverride = nativeBalanceOverride(SIMULATION_ACCOUNT);
    } else {
      const spentToken = direction === 'buy' ? quoteAssetAddress : tokenAddress;
      const layouts = await discoverErc20Layouts(client, spentToken);
      stateOverride = spendStateOverride({ layouts, token: spentToken, owner: SIMULATION_ACCOUNT, spender: curveAddress });
    }
    if (!stateOverride || signal.aborted) return null;

    const quote: QuoteFn = async (amountIn) => {
      try {
        const { data } = await client.call({
          to: curveAddress,
          data: encodeFunctionData({ abi: curveTradeAbi, functionName: direction, args: [amountIn, 0n, SIMULATION_ACCOUNT] }),
          account: SIMULATION_ACCOUNT,
          value: direction === 'buy' && isNativeQuote ? amountIn : undefined,
          stateOverride,
        });
        if (!data) return null;
        return decodeFunctionResult({ abi: curveTradeAbi, functionName: direction, data });
      } catch {
        return null;
      }
    };

    const state = await readCurveState(client, curveAddress);
    const guess = state ? (direction === 'buy' ? guessBuyInput(state, targetOut) : guessSellInput(state, targetOut)) : null;
    return solveInputForOutput(quote, targetOut, { signal, initialGuess: guess ?? undefined });
  };
}
```

- [ ] **Step 5: Run to verify pass, typecheck** — `npx vitest run src/trading/reverse-quote.test.ts && npx tsc --noEmit`. Expected: PASS. Note `usePublicClient()`'s return type must be assignable to `CallClient` (its `call` takes `{ to, data, account, value, stateOverride, … }`); if `tsc` rejects the structural match, widen `CallClient.call`'s parameter type to what viem's `PublicClient['call']` accepts rather than casting at call sites.

- [ ] **Step 6: Commit**

```bash
git add src/trading/reverse-quote.ts src/trading/reverse-quote.test.ts src/trading/v3QuoterAbi.ts
git commit -m "feat: add per-venue reverse quote builders with simulation state overrides

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Backend — expose the quote asset's USD price on the launch detail

Why: Uniswap shows a `$` value under **both** cards, each from that token's own market price; the gap between them is the price impact plus fees (e.g. 50 ETH ≈ $123,708 in, 1,352,430 AI ≈ $118,357 out → −4.3%). The API exposes only the launched token's `priceUsd` (computed in `computeStats` as `price-in-quote × quote USD price`, and withheld while indexed coverage is incomplete). The quote asset's own USD price already exists in the backend (`readUsdPrice` → verified Chainlink feed via `quote_usd_feeds`), and it does **not** depend on coverage. This task exposes it on the **detail endpoint only** (the list endpoint is untouched — no extra per-row work), as one additive nullable field.

**Files (run from `be/`):**
- Modify: `be/src/api/schemas.ts` (`launchDetail.properties`: add `quotePriceUsd`)
- Modify: `be/src/api/server.ts` (`LaunchDetail` interface: add `quotePriceUsd: string | null`)
- Modify: `be/src/api/store.ts` (`getLaunch` + one small helper)
- Test: `be/src/api/store.integration.test.ts`, `be/src/api/server.test.ts`
- Regenerate (never hand-edit): `be/openapi.json` (`npm run openapi:write`), `fe/src/api/schema.ts` (from `fe/`: `npm run generate:schema`)

**Interfaces:**
- Produces: `LaunchDetail.quotePriceUsd: string | null` — USD per 1 whole unit of the launch's quote asset, as a decimal string (same formatting as the existing `priceUsd`); `null` when the quote asset has no verified feed, the store has no `rpcClient`, or the read fails. Independent of launch coverage. Never `"0"` as a placeholder.

**Heads-up:** `be/src/api/store.ts`, `be/src/api/server.ts`, `be/src/api/server.test.ts`, `be/src/api/store.integration.test.ts` and `fe/src/api/schema.ts` already have uncommitted changes from other work — see Global Constraints; stage only your own hunks (`git add -p`). For the two generated files, regenerate, then stage only the `quotePriceUsd` hunks (the other pending hunks in `fe/src/api/schema.ts` are not yours).

- [ ] **Step 1: Write the failing tests**

In `store.integration.test.ts`, next to `'getLaunch also returns real stats for a single launch'` (it already defines `rpcClient()` — a fake `readContract` returning feed `decimals` 8 and `latestRoundData` 269170223591 ⇒ 2691.70223591 USD for the ETH quote used by `goodToken`):

```ts
it('getLaunch returns the quote asset USD price when an rpcClient is configured', async () => {
  const storeWithRpc = createApiStore(pool, { readContract: rpcClient() } as never);
  const detail = await storeWithRpc.getLaunch(4663, goodToken);
  expect(detail).not.toBeNull();
  expect(detail!.quotePriceUsd).not.toBeNull();
  expect(Number(detail!.quotePriceUsd)).toBeCloseTo(2691.70223591, 5);
});

it('getLaunch returns quotePriceUsd null (not 0) when no rpcClient is configured', async () => {
  const detail = await createApiStore(pool).getLaunch(4663, goodToken);
  expect(detail!.quotePriceUsd).toBeNull();
  expect(detail!.name).toBe('Stats0'); // the detail still loads
});

it('getLaunch still loads, with quotePriceUsd null, when the quote asset has no verified feed', async () => {
  // Insert a launch the same way this file's beforeAll inserts goodToken, but with a quote asset
  // that is NOT in quote_usd_feeds (e.g. '0x' + 'ab'.repeat(20)); delete it in afterAll.
  const detail = await createApiStore(pool, { readContract: rpcClient() } as never).getLaunch(4663, noFeedToken);
  expect(detail).not.toBeNull();
  expect(detail!.quotePriceUsd).toBeNull();
});
```
(`'Stats0'` is `goodToken`'s name in this file's fixtures; the assertion only proves the detail still returns. Add the `noFeedToken` insert/cleanup to the file's setup/teardown following its existing pattern.)

In `server.test.ts`, extend the existing launch-detail route test's fake `data` store: give its detail fixture `quotePriceUsd: '2691.7'` and assert the JSON body contains `"quotePriceUsd":"2691.7"`; add a second case with `quotePriceUsd: null` asserting the field is present and `null` (Fastify's response schema must not drop it).

- [ ] **Step 2: Run to verify failure**

Run (from `be/`): `npm run test:integration -- src/api/store.integration.test.ts -t "quote asset USD price"` and `npx vitest run src/api/server.test.ts`
Expected: FAIL (`quotePriceUsd` undefined / not in the schema). Also run `npx tsc --noEmit` after Step 3 — it will flag every `LaunchDetail` fixture missing the new required field; add `quotePriceUsd: null` to each.

- [ ] **Step 3: Implement**

`schemas.ts` — in `launchDetail.properties` (next to `priceQuote`/`priceStale`):

```ts
  // USD per 1 whole unit of the launch's quote asset (Chainlink feed), or null. Independent of
  // coverage: unlike priceUsd/FDV it needs no indexed trades.
  quotePriceUsd: { type: 'string', nullable: true },
```

`server.ts` — `LaunchDetail`:

```ts
  priceStale: boolean;
  quotePriceUsd: string | null;
```

`store.ts` — a helper beside `cachedUsdPrice`:

```ts
// The quote asset's own USD price for the launch detail. Unlike priceUsd it does not depend on the
// launch's coverage. A feed or RPC failure must never fail the whole detail request.
async function readQuotePriceUsd(pool: Pool, client: UsdPriceClient | undefined, quoteAssetAddress: string): Promise<string | null> {
  if (!client) return null;
  try {
    const price = await cachedUsdPrice(pool, client, quoteAssetAddress);
    return price ? String(price.priceUsd) : null;
  } catch {
    return null;
  }
}
```

and in `getLaunch`, start it with the other reads and include it in the returned object:

```ts
      const quotePriceUsdPromise = readQuotePriceUsd(pool, rpcClient, string(row.quote_asset_address));
      …
      return { ...summary(row, complete, stats),
        …existing fields…,
        quotePriceUsd: await quotePriceUsdPromise,
        priceStale: … };
```
(`rpcClient` is the `createApiStore(pool, rpcClient?)` parameter already in scope; production wires it in `be/src/cli/api.ts`. Do not touch `listLaunches`.)

- [ ] **Step 4: Run to verify pass, typecheck, lint, openapi**

Run (from `be/`): `npm run test:integration -- src/api/store.integration.test.ts && npx vitest run src/api/server.test.ts && npx tsc --noEmit && npx eslint src/api/store.ts src/api/server.ts src/api/schemas.ts && npm run openapi:write && npm run openapi:check`
Expected: all pass; `git diff be/openapi.json` shows only the added `quotePriceUsd` property. If `openapi:write` also rewrites unrelated parts because of other pending work in `schemas.ts`, stage only the `quotePriceUsd` hunk.

- [ ] **Step 5: Regenerate the frontend schema**

Run (from `fe/`): `npm run generate:schema` then `npx tsc --noEmit`. Expected: `LaunchDetail` in `fe/src/api/schema.ts` gains `quotePriceUsd?: string | null` (Fastify marks nullable fields optional-or-null — match the existing `priceUsd` shape); the project typechecks. Fix any FE fixture the new field breaks (`quotePriceUsd: null`) — e.g. `fe/e2e/fixtures.ts`/`mock-api.ts` detail mocks and `launch-detail.test.tsx` builders; for the e2e mock set `quotePriceUsd: '3000'` so Task 13 can assert a USD line.

- [ ] **Step 6: Commit (only your hunks — see the heads-up)**

```bash
git add -p be/src/api/schemas.ts be/src/api/server.ts be/src/api/store.ts be/src/api/store.integration.test.ts be/src/api/server.test.ts be/openapi.json fe/src/api/schema.ts
git commit -m "feat: expose the quote asset USD price on the launch detail

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `useReverseQuote` (debounced, abortable) and `useSwapAmounts`

**Files:**
- Create: `fe/src/trading/use-reverse-quote.ts`, `fe/src/trading/use-swap-amounts.ts`
- Test: `fe/src/trading/use-reverse-quote.test.ts`, `fe/src/trading/use-swap-amounts.test.ts`

**Interfaces:**
- Consumes: `ReverseSolve` (Task 4); `parseAmountSafe`, from `./amount`.
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

### Task 7: `TradeCard`, `SwapShell`, USD helper

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
  - `type UsdPrices = Record<string, string | null>` (lowercased token address → USD price per whole token, or null) and `usdPriceFor(prices: UsdPrices | undefined, address: string): string | null` (case-insensitive lookup; `null` for a missing/null entry), both in `trade-usd.ts`
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
import { usdPriceFor, usdText } from './trade-usd';

describe('usdPriceFor', () => {
  const prices = { '0xabc0000000000000000000000000000000000001': '2.5', '0xabc0000000000000000000000000000000000002': null };
  it('looks the address up case-insensitively', () => {
    expect(usdPriceFor(prices, '0xABC0000000000000000000000000000000000001')).toBe('2.5');
  });
  it('is null for a null entry, a missing entry, or no prices at all', () => {
    expect(usdPriceFor(prices, '0xabc0000000000000000000000000000000000002')).toBeNull();
    expect(usdPriceFor(prices, '0xabc0000000000000000000000000000000000003')).toBeNull();
    expect(usdPriceFor(undefined, '0xabc0000000000000000000000000000000000001')).toBeNull();
  });
});

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

// Lowercased token address -> USD price per whole token (decimal string), or null when unknown.
export type UsdPrices = Record<string, string | null>;

export function usdPriceFor(prices: UsdPrices | undefined, address: string): string | null {
  return prices?.[address.toLowerCase()] ?? null;
}

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

### Task 8: Trade button states (Connect / Getting quote… / Not enough X / Swap) and the shared "open wallet dialog" request

What the user asked for (Uniswap behavior): not connected → the button says **Connect** and opens the wallet dialog; while the app is simulating to find the price → **Getting quote…**; once ready, if the wallet lacks the token being entered (e.g. ETH) → **Not enough ETH**; otherwise → **Swap**. Today `ApproveOrActionButton` has no connect state (a disconnected wallet falls into "Switch network" because `chainId` is undefined) and no quoting state (it shows a disabled "Swap").

**Files:**
- Create: `fe/src/trading/trade-button-state.ts`, `fe/src/trading/trade-button-state.test.ts`
- Create: `fe/src/wallet/open-wallet-dialog.ts`, `fe/src/wallet/open-wallet-dialog.test.ts`
- Modify: `fe/src/wallet/wallet-control.tsx`, `fe/src/wallet/wallet-control.test.tsx` (already has uncommitted changes from other work — see Global Constraints; stage only your hunks)
- Modify: `fe/src/trading/approve-or-action-button.tsx` (has a pending one-line `cursor-pointer` change from other work — stage only your hunks), `fe/src/trading/approve-or-action-button.test.tsx`

**Interfaces:**
- Produces (`trade-button-state.ts`):

```ts
export type QuoteState = 'idle' | 'loading' | 'ready' | 'unavailable';
export type TradeButtonKind =
  | 'connect' | 'switch-network' | 'enter-amount' | 'loading-quote' | 'loading-balance'
  | 'insufficient' | 'approve' | 'quote-unavailable' | 'swap';
export interface TradeButtonInput {
  isConnected: boolean;
  isWrongChain: boolean;
  amountIn: bigint;               // the exact input that will be executed (0n until known/derived)
  quoteState: QuoteState;
  balanceKnown: boolean;          // false while the sold token's balance is still loading
  hasInsufficientBalance: boolean;
  needsApproval: boolean;
  canBatchApprove: boolean;
  tokenInSymbol: string | undefined;
}
export interface TradeButtonState { kind: TradeButtonKind; label: string; disabled: boolean }
export function resolveTradeButton(input: TradeButtonInput): TradeButtonState;
export function deriveQuoteState(input: {
  source: 'sell' | 'buy'; reverseStatus: 'idle' | 'loading' | 'ok' | 'unavailable';
  amountIn: bigint; outputAmount: bigint | null; errorMessage: string | null;
}): QuoteState;
```
- Produces (`open-wallet-dialog.ts`): `OPEN_WALLET_DIALOG_EVENT = 'open-wallet-dialog'` and `openWalletDialog(): void` (dispatches that event on `window`). The header's `WalletControl` — always mounted by `AppShell` — listens and opens its existing connect dialog; no wallet code is duplicated.
- Changes `ApproveOrActionButton` props: **replaces** `outputAmount: bigint | null` with `quoteState: QuoteState`, and **adds** `isConnected: boolean`, `balanceKnown: boolean`, `onConnect: () => void`. Everything else (`needsApproval`, `amountIn`, `approveAmount?`, `isWrongChain`, `hasInsufficientBalance`, `tokenInSymbol?`, `canBatchApprove?`, `isSubmitting`, `allowance`, `actionLabel`, `onAction`) is unchanged. Its callers (the V3, V4 and curve panels) are all updated by Tasks 9–11 of this plan; the old Buy/Sell panels it also served are deleted in Task 12.

**The ladder (first match wins; the copy is part of the contract):**

| # | Condition | Kind | Label | Enabled |
|---|---|---|---|---|
| 1 | not connected | `connect` | `Connect` | yes — opens the wallet dialog |
| 2 | wrong chain | `switch-network` | `Switch network` | no (unchanged from today) |
| 3 | `amountIn === 0n` and `quoteState === 'loading'` (a Buy-typed amount is still being turned into an input) | `loading-quote` | `Getting quote…` | no |
| 3b | `amountIn === 0n` and `quoteState === 'unavailable'` | `quote-unavailable` | `Quote unavailable` | no |
| 3c | `amountIn === 0n` otherwise | `enter-amount` | `Enter an amount` | no |
| 4 | balance still loading | `loading-balance` | `Checking balance…` | no |
| 5 | `hasInsufficientBalance` | `insufficient` | `Not enough {symbol}` (`token` if unknown) | no |
| 6 | `needsApproval && !canBatchApprove` | `approve` | `Approve` (the existing Approve/Approving…/Confirming approval… states stay inside the component) | yes |
| 7 | `quoteState` is `loading` or `idle` with an amount | `loading-quote` | `Getting quote…` | no |
| 8 | `quoteState === 'unavailable'` | `quote-unavailable` | `Quote unavailable` | no |
| 9 | otherwise | `swap` | `Swap` (the caller's `actionLabel`) | yes, unless `isSubmitting` |

`deriveQuoteState`: `source === 'buy'` and `reverseStatus === 'loading'` → `loading`; `source === 'buy'` and `reverseStatus === 'unavailable'` → `unavailable`; `amountIn === 0n` → `idle`; `outputAmount !== null` → `ready`; `errorMessage !== null` → `unavailable`; else `loading` (the forward quote is still being simulated).

- [ ] **Step 1: Write the failing tests**

```ts
// fe/src/trading/trade-button-state.test.ts
import { describe, expect, it } from 'vitest';
import { deriveQuoteState, resolveTradeButton, type TradeButtonInput } from './trade-button-state';

const ready: TradeButtonInput = {
  isConnected: true, isWrongChain: false, amountIn: 10n ** 18n, quoteState: 'ready',
  balanceKnown: true, hasInsufficientBalance: false, needsApproval: false, canBatchApprove: false, tokenInSymbol: 'ETH',
};
const resolve = (over: Partial<TradeButtonInput>) => resolveTradeButton({ ...ready, ...over });

describe('resolveTradeButton', () => {
  it('connect comes first, even with no amount and a wrong chain', () => {
    expect(resolve({ isConnected: false, amountIn: 0n, isWrongChain: true })).toEqual({ kind: 'connect', label: 'Connect', disabled: false });
  });
  it('wrong chain', () => {
    expect(resolve({ isWrongChain: true })).toEqual({ kind: 'switch-network', label: 'Switch network', disabled: true });
  });
  it('no amount', () => {
    expect(resolve({ amountIn: 0n, quoteState: 'idle' })).toEqual({ kind: 'enter-amount', label: 'Enter an amount', disabled: true });
  });
  it('a Buy-typed amount still being converted shows Getting quote…', () => {
    expect(resolve({ amountIn: 0n, quoteState: 'loading' })).toEqual({ kind: 'loading-quote', label: 'Getting quote…', disabled: true });
  });
  it('a Buy-typed amount with no answer shows Quote unavailable', () => {
    expect(resolve({ amountIn: 0n, quoteState: 'unavailable' })).toEqual({ kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true });
  });
  it('balance still loading never claims "Not enough"', () => {
    expect(resolve({ balanceKnown: false, hasInsufficientBalance: true })).toEqual({ kind: 'loading-balance', label: 'Checking balance…', disabled: true });
  });
  it('insufficient balance names the token being entered', () => {
    expect(resolve({ hasInsufficientBalance: true })).toEqual({ kind: 'insufficient', label: 'Not enough ETH', disabled: true });
    expect(resolve({ hasInsufficientBalance: true, tokenInSymbol: undefined }).label).toBe('Not enough token');
  });
  it('insufficient balance wins over a quote that is still loading (the amount is already known)', () => {
    expect(resolve({ hasInsufficientBalance: true, quoteState: 'loading' }).kind).toBe('insufficient');
  });
  it('approval needed (no batching) shows Approve even before the quote is available', () => {
    expect(resolve({ needsApproval: true, quoteState: 'unavailable' })).toEqual({ kind: 'approve', label: 'Approve', disabled: false });
  });
  it('approval is skipped when the wallet batches it', () => {
    expect(resolve({ needsApproval: true, canBatchApprove: true }).kind).toBe('swap');
  });
  it('quote loading / idle with an amount', () => {
    expect(resolve({ quoteState: 'loading' }).label).toBe('Getting quote…');
    expect(resolve({ quoteState: 'idle' }).label).toBe('Getting quote…');
  });
  it('quote unavailable', () => {
    expect(resolve({ quoteState: 'unavailable' })).toEqual({ kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true });
  });
  it('ready to swap', () => {
    expect(resolve({})).toEqual({ kind: 'swap', label: 'Swap', disabled: false });
  });
});

describe('deriveQuoteState', () => {
  const base = { source: 'sell' as const, reverseStatus: 'idle' as const, amountIn: 1n, outputAmount: null, errorMessage: null };
  it('buy-typed: follows the reverse quote', () => {
    expect(deriveQuoteState({ ...base, source: 'buy', reverseStatus: 'loading', amountIn: 0n })).toBe('loading');
    expect(deriveQuoteState({ ...base, source: 'buy', reverseStatus: 'unavailable', amountIn: 0n })).toBe('unavailable');
  });
  it('no amount → idle', () => {
    expect(deriveQuoteState({ ...base, amountIn: 0n })).toBe('idle');
  });
  it('forward quote: ready, unavailable on error, loading otherwise', () => {
    expect(deriveQuoteState({ ...base, outputAmount: 5n })).toBe('ready');
    expect(deriveQuoteState({ ...base, errorMessage: 'revert' })).toBe('unavailable');
    expect(deriveQuoteState(base)).toBe('loading');
  });
});
```

```ts
// fe/src/wallet/open-wallet-dialog.test.ts
import { describe, expect, it, vi } from 'vitest';
import { OPEN_WALLET_DIALOG_EVENT, openWalletDialog } from './open-wallet-dialog';

describe('openWalletDialog', () => {
  it('dispatches the open-wallet-dialog event on window', () => {
    const handler = vi.fn();
    window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
    openWalletDialog();
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
  });
});
```

In `wallet-control.test.tsx` add (import `act` from `@testing-library/react` and `openWalletDialog` from `./open-wallet-dialog`):

```tsx
it('opens the connect dialog when a trade panel asks for it', () => {
  render(<WalletControl />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  act(() => openWalletDialog());
  expect(screen.getByRole('dialog', { name: 'Connect a wallet' })).toBeInTheDocument();
});

it('ignores that request while a wallet is already connected', () => {
  hooks.account = { address: '0x1111111111111111111111111111111111111111', chainId: 4663, isConnected: true, status: 'connected' };
  render(<WalletControl />);
  act(() => openWalletDialog());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
```

In `approve-or-action-button.test.tsx`: first update every existing render to the new props (`outputAmount` → `quoteState`, plus `isConnected: true`, `balanceKnown: true`, `onConnect: vi.fn()`) — existing behavior assertions (Approve flow, approval error alert, batching skip, labels) must keep passing — then add:

```tsx
it('shows Connect when disconnected, and clicking it calls onConnect', () => {
  const onConnect = vi.fn();
  render(<ApproveOrActionButton {...baseProps} isConnected={false} amountIn={0n} onConnect={onConnect} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(onConnect).toHaveBeenCalledTimes(1);
});
it('does not call that a wrong network when no wallet is connected', () => {
  render(<ApproveOrActionButton {...baseProps} isConnected={false} isWrongChain />);
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  expect(screen.queryByText('Switch network')).not.toBeInTheDocument();
});
it('shows Getting quote… (disabled) while the quote is being simulated', () => {
  render(<ApproveOrActionButton {...baseProps} quoteState="loading" />);
  expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();
});
it('shows Not enough {symbol} (disabled) when the wallet cannot cover the amount', () => {
  render(<ApproveOrActionButton {...baseProps} hasInsufficientBalance tokenInSymbol="ETH" />);
  expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();
});
it('shows Swap (enabled) when everything is ready, and calls onAction', () => {
  const onAction = vi.fn();
  render(<ApproveOrActionButton {...baseProps} onAction={onAction} />);
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
  expect(onAction).toHaveBeenCalledTimes(1);
});
it('shows Quote unavailable (disabled) when no quote can be produced', () => {
  render(<ApproveOrActionButton {...baseProps} quoteState="unavailable" />);
  expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
});
```
(`baseProps` = a fully-valid ready state: `isConnected`, `balanceKnown`, `quoteState: 'ready'`, `amountIn: 10n ** 18n`, `needsApproval: false`, `isWrongChain: false`, `hasInsufficientBalance: false`, `isSubmitting: false`, an `allowance` stub with `isApproving: false, isConfirmingApproval: false, approveError: null, approve: vi.fn()`, `actionLabel: 'Swap'`, `onAction: vi.fn()`, `onConnect: vi.fn()`; reuse the file's existing helper if it already has one.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/trading/trade-button-state.test.ts src/wallet/open-wallet-dialog.test.ts src/wallet/wallet-control.test.tsx src/trading/approve-or-action-button.test.tsx` → FAIL (modules missing / new props).

- [ ] **Step 3: Implement**

```ts
// fe/src/wallet/open-wallet-dialog.ts
// A trade panel's "Connect" button asks the header's WalletControl (always mounted) to open the
// wallet dialog it already owns — one dialog, no duplicated connector logic.
export const OPEN_WALLET_DIALOG_EVENT = 'open-wallet-dialog';

export function openWalletDialog(): void {
  window.dispatchEvent(new Event(OPEN_WALLET_DIALOG_EVENT));
}
```

`wallet-control.tsx` — beside the existing hooks, BEFORE the early returns (`status === 'reconnecting'` / connected branches), add (import `OPEN_WALLET_DIALOG_EVENT` from `./open-wallet-dialog`):

```tsx
  // A trade panel's Connect button asks for this dialog. Ignored while connected, so a request can
  // never leave `open` stuck true and pop the dialog up after a later disconnect.
  useEffect(() => {
    if (isConnected) return;
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
    return () => window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
  }, [isConnected]);
```

```ts
// fe/src/trading/trade-button-state.ts
export type QuoteState = 'idle' | 'loading' | 'ready' | 'unavailable';
export type TradeButtonKind =
  | 'connect' | 'switch-network' | 'enter-amount' | 'loading-quote' | 'loading-balance'
  | 'insufficient' | 'approve' | 'quote-unavailable' | 'swap';

export interface TradeButtonInput {
  isConnected: boolean;
  isWrongChain: boolean;
  amountIn: bigint;
  quoteState: QuoteState;
  balanceKnown: boolean;
  hasInsufficientBalance: boolean;
  needsApproval: boolean;
  canBatchApprove: boolean;
  tokenInSymbol: string | undefined;
}

export interface TradeButtonState {
  kind: TradeButtonKind;
  label: string;
  disabled: boolean;
}

// The one place that decides what the trade button says. First match wins; see the plan's ladder.
export function resolveTradeButton(input: TradeButtonInput): TradeButtonState {
  const { isConnected, isWrongChain, amountIn, quoteState, balanceKnown, hasInsufficientBalance, needsApproval, canBatchApprove, tokenInSymbol } = input;
  if (!isConnected) return { kind: 'connect', label: 'Connect', disabled: false };
  if (isWrongChain) return { kind: 'switch-network', label: 'Switch network', disabled: true };
  if (amountIn === 0n) {
    if (quoteState === 'loading') return { kind: 'loading-quote', label: 'Getting quote…', disabled: true };
    if (quoteState === 'unavailable') return { kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true };
    return { kind: 'enter-amount', label: 'Enter an amount', disabled: true };
  }
  if (!balanceKnown) return { kind: 'loading-balance', label: 'Checking balance…', disabled: true };
  if (hasInsufficientBalance) return { kind: 'insufficient', label: `Not enough ${tokenInSymbol ?? 'token'}`, disabled: true };
  if (needsApproval && !canBatchApprove) return { kind: 'approve', label: 'Approve', disabled: false };
  if (quoteState === 'loading' || quoteState === 'idle') return { kind: 'loading-quote', label: 'Getting quote…', disabled: true };
  if (quoteState === 'unavailable') return { kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true };
  return { kind: 'swap', label: 'Swap', disabled: false };
}

export function deriveQuoteState(input: {
  source: 'sell' | 'buy';
  reverseStatus: 'idle' | 'loading' | 'ok' | 'unavailable';
  amountIn: bigint;
  outputAmount: bigint | null;
  errorMessage: string | null;
}): QuoteState {
  const { source, reverseStatus, amountIn, outputAmount, errorMessage } = input;
  if (source === 'buy' && reverseStatus === 'loading') return 'loading';
  if (source === 'buy' && reverseStatus === 'unavailable') return 'unavailable';
  if (amountIn === 0n) return 'idle';
  if (outputAmount !== null) return 'ready';
  if (errorMessage !== null) return 'unavailable';
  return 'loading';
}
```

`approve-or-action-button.tsx` — keep the approve-state handling (`isApproving` / `isConfirmingApproval` / `approveError`) and the exported `ApproveOrActionAllowance`; replace the body's decision ladder with the resolver:

```tsx
export function ApproveOrActionButton(props: ApproveOrActionButtonProps) {
  const { needsApproval, amountIn, approveAmount, isWrongChain, hasInsufficientBalance, tokenInSymbol, canBatchApprove,
    quoteState, isConnected, balanceKnown, onConnect, isSubmitting, allowance, actionLabel, onAction } = props;
  const state = resolveTradeButton({ isConnected, isWrongChain, amountIn, quoteState, balanceKnown, hasInsufficientBalance,
    needsApproval, canBatchApprove: Boolean(canBatchApprove), tokenInSymbol });
  const approveError = allowance.approveError && (
    <p role="alert" className="text-sm text-destructive">{allowance.approveError}</p>
  );

  if (state.kind === 'connect') {
    return <Button type="button" className="cursor-pointer" onClick={onConnect}>{state.label}</Button>;
  }
  if (state.kind === 'approve') {
    return (
      <>
        {approveError}
        <Button type="button" className="cursor-pointer"
          disabled={allowance.isApproving || allowance.isConfirmingApproval}
          onClick={() => allowance.approve(approveAmount ?? amountIn)}>
          {allowance.isApproving ? 'Approving…' : allowance.isConfirmingApproval ? 'Confirming approval…' : state.label}
        </Button>
      </>
    );
  }
  return (
    <>
      {approveError}
      <Button type="button" className="cursor-pointer" disabled={state.disabled || (state.kind === 'swap' && isSubmitting)}
        onClick={state.kind === 'swap' ? onAction : undefined}>
        {state.kind === 'swap' ? actionLabel : state.label}
      </Button>
    </>
  );
}
```
(Update the props interface: remove `outputAmount`, add `quoteState: QuoteState; isConnected: boolean; balanceKnown: boolean; onConnect: () => void`, and import `Button`, `resolveTradeButton`, `QuoteState`.)

**Panel wiring snippet (used by Tasks 9–11; shown once here):** in each panel, `const { address: account, chainId, isConnected } = useAccount();` (add `isConnected`), `import { openWalletDialog } from '@/wallet/open-wallet-dialog'`, `import { deriveQuoteState } from './trade-button-state'`, and:

```tsx
const quoteState = deriveQuoteState({
  source: amounts.source, reverseStatus: amounts.reverseStatus, amountIn,
  outputAmount: quote.outputAmount, errorMessage: quote.errorMessage,
});
…
<ApproveOrActionButton
  …existing props…
  quoteState={allowanceStillLoading ? 'loading' : quoteState}   // V3/V4: allowanceStillLoading = erc20Allowance.isAllowanceLoading; curve: just quoteState
  isConnected={isConnected}
  balanceKnown={sellsNativeBalanceKnown}                        // the sold token's balance has loaded (native: `nativeBalance.data !== undefined`; ERC20: `tokenInBalance !== undefined`)
  onConnect={openWalletDialog}
/>
```
and the panel tests' `hooks.account` gets `isConnected: true` (default) so every existing assertion keeps its meaning.

- [ ] **Step 4: Run to verify pass, typecheck, lint** — `npx vitest run src/trading/trade-button-state.test.ts src/wallet src/trading/approve-or-action-button.test.tsx && npx tsc --noEmit`. `tsc` WILL flag the V3/V4/curve panels (they still pass `outputAmount`) — that is expected until Tasks 9–11; to keep this commit green, in this task only update the three existing callers minimally (`outputAmount={x}` → `quoteState={x === null ? 'loading' : 'ready'}`, plus `isConnected={true}`, `balanceKnown={true}`, `onConnect={openWalletDialog}`) and let Tasks 9–11 replace that placeholder with the real wiring. The old `buy-panel.tsx` / `sell-panel.tsx` callers get the same minimal change and are deleted in Task 12.

- [ ] **Step 5: Commit (only your hunks)**

```bash
git add src/trading/trade-button-state.ts src/trading/trade-button-state.test.ts src/wallet/open-wallet-dialog.ts src/wallet/open-wallet-dialog.test.ts
git add -p src/wallet/wallet-control.tsx src/wallet/wallet-control.test.tsx src/trading/approve-or-action-button.tsx src/trading/approve-or-action-button.test.tsx src/trading/swap-panel.tsx src/trading/v4-swap-panel.tsx src/trading/buy-panel.tsx src/trading/sell-panel.tsx
git commit -m "feat: trade button states (Connect, Getting quote, Not enough, Swap) and open-wallet-dialog request

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Migrate the V3 `SwapPanel` (`swap-panel.tsx`)

**Files:**
- Modify: `fe/src/trading/swap-panel.tsx`
- Modify (test): `fe/src/trading/swap-panel.test.tsx`

**Interfaces:**
- Consumes: `useSwapAmounts` (Task 6), `makeV3ReverseSolve` (Task 4), `TradeCard`, `SwapShell`, `usdText` (Task 7); wagmi `usePublicClient`.
- Produces: `SwapPanelProps` gains optional `usdPrices?: UsdPrices` (a `$` line shows on each side whose token address has a non-null entry). All other props unchanged.

- [ ] **Step 1: Update the mocks and add the new failing tests**

In `swap-panel.test.tsx` the reverse builder is mocked at its module boundary (Task 4 already tests the builder itself; here we test the panel's wiring). Add:

```tsx
const reverse = vi.hoisted(() => ({
  solve: vi.fn<(target: bigint, signal: AbortSignal) => Promise<bigint | null>>(),
  makeV3: vi.fn(),
}));
vi.mock('./reverse-quote', () => ({
  makeV3ReverseSolve: (...args: unknown[]) => { reverse.makeV3(...args); return reverse.solve; },
}));
```
add `usePublicClient: () => ({})` to the `vi.mock('wagmi', …)` object (a truthy client), and in `beforeEach`: `reverse.solve.mockReset(); reverse.solve.mockImplementation(async (target) => target * 2n); reverse.makeV3.mockClear();`. Replace every `screen.getByLabelText(/amount/i)` with `screen.getByLabelText('Sell amount')`; `getByText('Sell')` stays valid. Existing behavioral assertions (Approve/Swap/permit/batch/slippage) must stay and keep passing. Then add (import `act` from `@testing-library/react`, and `decodeAbiParameters, parseAbiParameters` from `viem`):

```tsx
it('typing in Buy derives the Sell amount via the V3 reverse solver and submits exact-input with it', async () => {
  vi.useFakeTimers();
  reverse.solve.mockResolvedValue(2_000_000_000_000_000_000n);
  hooks.simulateData = { result: [1_000_000_000_000_000_000n, 0n, 1, 1n] }; // forward quote at the derived input
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '1' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(reverse.makeV3).toHaveBeenCalledWith({}, { tokenIn: tokenA.address, tokenOut: tokenB.address, fee: 10000 });
  expect(reverse.solve).toHaveBeenCalledWith(1_000_000_000_000_000_000n, expect.anything());
  expect(screen.getByLabelText('Sell amount')).toHaveValue(2);
  vi.useRealTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
  expect(hooks.writeContract).toHaveBeenCalledTimes(1);
  // The submitted V3 swap input carries the DERIVED 2e18 as its exact amountIn. Read the call the
  // same way this file's existing 'Swap' tests do; with sufficient allowances no permit/wrap input
  // is prepended, so the swap input is inputs[0] (mirror v3SwapEncoding.test.ts if the layout differs).
  const [, inputs] = hooks.writeContract.mock.calls[0][0].args;
  const [, amountIn] = decodeAbiParameters(parseAbiParameters('address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser'), inputs[0]);
  expect(amountIn).toBe(2_000_000_000_000_000_000n);
});

it('shows "Quote unavailable" and disables Swap when the reverse quote has no answer', async () => {
  vi.useFakeTimers();
  reverse.solve.mockResolvedValue(null);
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '999999999' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText('Quote unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
  vi.useRealTimers();
});

it('never calls the reverse solver when the user typed in Sell, or typed garbage in Buy', async () => {
  vi.useFakeTimers();
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '.' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(reverse.solve).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it('flip keeps the typed number on the same token', () => {
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
  expect(screen.getByLabelText('Buy amount')).toHaveValue(5);
});

it('Connect asks the header to open the wallet dialog', () => {
  hooks.account.isConnected = false;
  hooks.account.address = undefined;
  const handler = vi.fn();
  window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler); // from '@/wallet/open-wallet-dialog'
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(handler).toHaveBeenCalledTimes(1);
  window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
});

it('walks the button through Connect → Getting quote… → Not enough LAUNCH → Swap', () => {
  // add `isConnected: true` to hooks.account and reset it in beforeEach
  hooks.account.isConnected = false;
  hooks.account.address = undefined;
  const props = { poolAddress, tokenA, tokenB, explorerBase: null };
  const { rerender } = render(<SwapPanel {...props} />);
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();

  hooks.account.isConnected = true;
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.simulateData = undefined; // the forward quote has not come back yet
  rerender(<SwapPanel {...props} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } });
  expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();

  hooks.simulateData = { result: [1_000_000_000_000_000_000n, 0n, 1, 1n] };
  hooks.balanceA = 0n; // tokenA (LAUNCH) is the token being sold
  rerender(<SwapPanel {...props} />);
  expect(screen.getByRole('button', { name: 'Not enough LAUNCH' })).toBeDisabled();

  hooks.balanceA = 10_000_000_000_000_000_000n;
  rerender(<SwapPanel {...props} />);
  expect(screen.getByRole('button', { name: 'Swap' })).toBeEnabled();
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

it('shows a USD line on each side that has a price, and hides the side that does not', () => {
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} usdPrices={{ [tokenA.address.toLowerCase()]: '2' }} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '3' } });
  expect(screen.getByText('$6.00')).toBeInTheDocument();
  expect(screen.queryByText(/^\$3000/)).not.toBeInTheDocument(); // the other side has no price: its line is hidden
});

it('shows both USD lines when both tokens have a price — their gap is the price impact plus fees', () => {
  hooks.simulateData = { result: [1_000_000_000_000_000_000n, 0n, 1, 1n] }; // 3 LAUNCH sell for 1 WETH out
  render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null}
    usdPrices={{ [tokenA.address.toLowerCase()]: '2', [tokenB.address.toLowerCase()]: '3000' }} />);
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '3' } });
  expect(screen.getByText('$6.00')).toBeInTheDocument();    // 3 LAUNCH x $2
  expect(screen.getByText('$3000.00')).toBeInTheDocument(); // 1 WETH x $3000
});
```

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
`tokenIn`/`tokenOut` derive from `direction` exactly as today (keep `direction` state). Imports: `useMemo`, `usePublicClient` (wagmi), `deriveQuoteState` (`./trade-button-state`), `openWalletDialog` (`@/wallet/open-wallet-dialog`), and destructure `isConnected` from `useAccount()`; `makeV3ReverseSolve`, `useSwapAmounts`, `TradeCard`, `SwapShell`, `usdText`, `usdPriceFor`, `UsdPrices` (from `./trade-usd`), `minReceivedText` (from `./trade-amount-format`). The Min received row uses the same `settings.slippageBps` and `'pool'` venue kind that `submitSwap`'s `applySlippage` uses — never recompute slippage a second way.

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
const priceFor = (token: SwapToken) => usdPriceFor(usdPrices, token.address);
const quoteState = deriveQuoteState({ source: amounts.source, reverseStatus: amounts.reverseStatus, amountIn, outputAmount: quote.outputAmount, errorMessage: quote.errorMessage });

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
        <ApproveOrActionButton … /* unchanged props, EXCEPT: drop `outputAmount` and use Task 8's wiring — quoteState={erc20Allowance.isAllowanceLoading ? 'loading' : quoteState} isConnected={isConnected} balanceKnown={nativeIn ? nativeBalance.data !== undefined : tokenInBalance !== undefined} onConnect={openWalletDialog} */ />
        <TradeStatus … /* unchanged */ />
      </>}
    />
  </SwapShell>
);
```
Add `usdPrices?: UsdPrices` to `SwapPanelProps` and the function parameters. Remove now-unused imports (`Input`, `Button`, `TradeSettingsPopover`, `parseAmountSafe` if unused). Keep `submitSwap`, quote hook, permit2, allowance, batching, ETH/WETH handling byte-for-byte.

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

### Task 10: Migrate the V4 `V4SwapPanel` (`v4-swap-panel.tsx`)

**Files:**
- Modify: `fe/src/trading/v4-swap-panel.tsx`
- Modify (test): `fe/src/trading/v4-swap-panel.test.tsx`

**Interfaces:**
- Consumes: as Task 9, with `makeV4ReverseSolve`.
- Produces: `V4SwapPanelProps` gains `usdPrices?: UsdPrices`; `V4SwapToken` gains optional `logoUri?: string | null` (default `null`) so the token pills can show logos (callers that don't have one pass nothing).

- [ ] **Step 1: Update mocks and add failing tests**

Same approach as Task 9: mock `./reverse-quote` (`makeV4ReverseSolve: (...a) => { reverse.makeV4(...a); return reverse.solve; }`), add `usePublicClient: () => ({})` to the wagmi mock, reset `reverse.solve` (default `async (t) => t * 2n`) in `beforeEach`, and change selectors `getByLabelText(/amount/i)` → `getByLabelText('Sell amount')`. Add the same six tests as Task 9 (Buy-derives-Sell and submits exact-input with the derived amount, unavailable disables, no solver call for Sell typing/garbage, flip keeps the typed number, Min received row, USD line), adapted for V4: assert `reverse.makeV4` was called with `({}, { poolKey, zeroForOne: true })` and read the submitted swap input the way this file's existing tests do (V4's `encodeV4SwapInput` — mirror `v4SwapEncoding.test.ts` to decode its `amountIn`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/trading/v4-swap-panel.test.tsx` → FAIL.

- [ ] **Step 3: Apply the same transformation as Task 9**

- `solve = useMemo(() => client ? makeV4ReverseSolve(client, { poolKey, zeroForOne }) : null, [client, poolKey, zeroForOne])` with `solveKey: \`v4:${poolKey.currency0}:${poolKey.currency1}:${poolKey.fee}:${poolKey.hooks}:${zeroForOne}\``. `poolKey` is a prop object — its identity can change each parent render, so key the memo on `JSON`-free primitives: `[client, poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks, zeroForOne]`.
- Token selectors: V4 has no ETH/WETH toggle today; render `TokenSelector` with a single fixed option per side: `{ key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri ?? null }`, `onSelect={() => {}}`, `chainId={robinhoodChain.id}`. Native ETH (`zeroAddress`) shows symbol `ETH` as today (the caller already passes the symbol).
- Venue label `"Uniswap V4 pool"`; `venueKind="pool"`.
- Pass `minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'pool', tokenOut.decimals, tokenOut.symbol)}` to `TradeCard` (same `applySlippage` inputs as `submitSwap`).
- Flip: `setDirection(...)` + `amounts.flip()`; every `setAmount('')` → `amounts.reset()`.
- Same `buyText`/hints/`quoteState` wiring as Task 9 (`deriveQuoteState`, `isConnected`, `balanceKnown` = `isNativeIn ? nativeBalance.data !== undefined : tokenInBalance !== undefined`, `onConnect={openWalletDialog}`; `quoteState={erc20Allowance.isAllowanceLoading ? 'loading' : quoteState}`). Keep `submitSwap`, permit2, allowance, batching unchanged.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/trading/v4-swap-panel.test.tsx && npx tsc --noEmit && npx eslint src/trading/v4-swap-panel.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trading/v4-swap-panel.tsx src/trading/v4-swap-panel.test.tsx
git commit -m "feat: V4 swap panel uses the shared card UI with two-way quoting

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `CurveSwapPanel` (replaces Buy/Sell/CurveTrade panels)

**Files:**
- Create: `fe/src/trading/curve-swap-panel.tsx`
- Test: `fe/src/trading/curve-swap-panel.test.tsx`
- Delete (end of task, after the new tests pass): `fe/src/trading/buy-panel.tsx`, `buy-panel.test.tsx`, `sell-panel.tsx`, `sell-panel.test.tsx`, `curve-trade-panel.tsx`, `curve-trade-panel.test.tsx`

**Interfaces:**
- Consumes: everything `BuyPanel`/`SellPanel` use today (`useCurveQuote`, `useTokenAllowance`, `useTradeSubmission`, `useCanBatchCalls`, `usePaymasterCapability`, `useRefetchQuoteAfterApproval`, `ApproveOrActionButton`, `TradeStatus`, `applySlippage`, `curveTradeAbi`, `erc20Abi`) plus Tasks 4–6.
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
  usdPrices?: UsdPrices;
}
```

- [ ] **Step 1: Port the behavior tests, then add the new ones**

Open `buy-panel.test.tsx` and `sell-panel.test.tsx`. Create `curve-swap-panel.test.tsx` with the same hoisted-`hooks` + `vi.mock('wagmi', …)` scaffolding (plus `usePublicClient: () => ({})` and the `./reverse-quote` module mock below), and port EVERY test from both files into one `describe` each — "buy direction (default)" and "sell direction (after flip)" — adapting only: the component under test, the input selector (`getByLabelText('Sell amount')` — in the default buy direction the Sell card is the quote asset; after clicking "Flip swap direction" the Sell card is the launched token), and the button label (`Swap` instead of `Buy`/`Sell`; labels follow Task 8's ladder: "Not enough X", "Approve", "Enter an amount", "Switch network" are unchanged; a button that used to be a disabled "Swap" because there was no quote is now "Getting quote…" or "Quote unavailable"; add `isConnected: true` to `hooks.account`). Keep each test's assertions on `writeContract`/`sendCalls` args identical (`buy`/`sell` function names, `value`, exact-amount approve, `minTokensOut`/`minQuoteOut` from `applySlippage(…,'curve')`). Add:

```tsx
// Mock the reverse builder at its module boundary (Task 4 tests the builder; here we test wiring).
const reverse = vi.hoisted(() => ({
  solve: vi.fn<(target: bigint, signal: AbortSignal) => Promise<bigint | null>>(),
  makeCurve: vi.fn(),
}));
vi.mock('./reverse-quote', () => ({
  makeCurveReverseSolve: (...args: unknown[]) => { reverse.makeCurve(...args); return reverse.solve; },
}));
// beforeEach: reverse.solve.mockReset(); reverse.solve.mockResolvedValue(1_000_000_000_000_000_000n); reverse.makeCurve.mockClear();

describe('button states', () => {
  it('Connect when no wallet is connected; clicking it asks the header to open the wallet dialog', () => {
    hooks.account.isConnected = false;
    hooks.account.address = undefined;
    const handler = vi.fn();
    window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
  });

  it('walks Getting quote… → Not enough ETH → Swap for a native-ETH buy', () => {
    const props = { curveAddress: curve, tokenAddress: token, tokenDecimals: 18, quoteAsset: nativeQuote, explorerBase: null };
    hooks.simulateData = undefined; // forward quote not back yet
    const { rerender } = render(<CurveSwapPanel {...props} />);
    fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();

    hooks.simulateData = { result: 5n * 10n ** 20n };
    hooks.balance = { data: { value: 0n }, isLoading: false }; // no ETH
    rerender(<CurveSwapPanel {...props} />);
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();

    hooks.balance = { data: { value: 10n ** 18n }, isLoading: false };
    rerender(<CurveSwapPanel {...props} />);
    expect(screen.getByRole('button', { name: 'Swap' })).toBeEnabled();
  });
});

describe('two-way amounts', () => {
  it('buy direction: typing in Buy derives the quote-asset amount from the curve reverse solver', async () => {
    vi.useFakeTimers();
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '10' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(reverse.makeCurve).toHaveBeenCalledWith({}, { curveAddress: curve, direction: 'buy', tokenAddress: token, quoteAssetAddress: nativeQuote.address, isNativeQuote: true });
    expect(reverse.solve).toHaveBeenCalledWith(10_000_000_000_000_000_000n, expect.anything());
    expect(screen.getByLabelText('Sell amount')).toHaveValue(1);
    vi.useRealTimers();
  });

  it('sell direction (after flip): the solver is built for sell', async () => {
    vi.useFakeTimers();
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(reverse.makeCurve).toHaveBeenLastCalledWith({}, { curveAddress: curve, direction: 'sell', tokenAddress: token, quoteAssetAddress: erc20Quote.address, isNativeQuote: false });
    vi.useRealTimers();
  });

  it('shows "Quote unavailable" and disables the button when the reverse solver has no answer', async () => {
    vi.useFakeTimers();
    reverse.solve.mockResolvedValue(null);
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '5' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByText('Quote unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
    vi.useRealTimers();
  });

  it('works without a connected wallet: the reverse solver does not depend on the account', async () => {
    vi.useFakeTimers();
    hooks.account.address = undefined;
    render(<CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '5' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(reverse.solve).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Sell amount')).toHaveValue(1);
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
import { usdPriceFor, usdText } from './trade-usd';
import { minReceivedText } from './trade-amount-format';
import { deriveQuoteState } from './trade-button-state';
import { openWalletDialog } from '@/wallet/open-wallet-dialog';

export function CurveSwapPanel({ curveAddress, tokenAddress, tokenDecimals, tokenSymbol, tokenLogoUri, quoteAsset, explorerBase, usdPrices }: CurveSwapPanelProps) {
  // 'buy' = quote asset -> launched token (curve.buy); 'sell' = launched token -> quote (curve.sell).
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const { address: account, chainId, isConnected } = useAccount();
  const { settings, update } = useTradeSettings();
  const isNativeQuote = quoteAsset.address === zeroAddress;
  const isWrongChain = chainId !== robinhoodChain.id;

  const launched = { address: tokenAddress, symbol: tokenSymbol ?? null, decimals: tokenDecimals, logoUri: tokenLogoUri ?? null };
  const quoteTok = { address: quoteAsset.address, symbol: quoteAsset.symbol, decimals: quoteAsset.decimals, logoUri: null as string | null };
  const tokenIn = direction === 'buy' ? quoteTok : launched;
  const tokenOut = direction === 'buy' ? launched : quoteTok;

  const client = usePublicClient({ chainId: robinhoodChain.id });
  // No dependence on the connected account: the reverse quote simulates as a synthetic account that
  // is given (state override) the balance and curve allowance it needs — see Task 4.
  const solve = useMemo(
    () => (client
      ? makeCurveReverseSolve(client, { curveAddress, direction, tokenAddress, quoteAssetAddress: quoteAsset.address, isNativeQuote })
      : null),
    [client, curveAddress, direction, tokenAddress, quoteAsset.address, isNativeQuote],
  );
  const amounts = useSwapAmounts({
    tokenInDecimals: tokenIn.decimals,
    tokenOutDecimals: tokenOut.decimals,
    solve,
    solveKey: `curve:${curveAddress}:${direction}`,
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
  const quoteState = deriveQuoteState({ source: amounts.source, reverseStatus: amounts.reverseStatus, amountIn, outputAmount: quote.outputAmount, errorMessage: quote.errorMessage });
  const buyText = amounts.source === 'buy'
    ? amounts.buyTypedText
    : (quote.outputAmount !== null ? formatUnits(quote.outputAmount, tokenOut.decimals) : '');
  const sellHint = reverseUnavailable ? 'Quote unavailable'
    : amounts.source === 'buy' && amounts.reverseStatus === 'loading' ? 'Estimating…' : null;
  const buyHint = amounts.source === 'sell' && amountIn > 0n && quote.outputAmount === null && quote.errorMessage
    ? `Quote unavailable: ${quote.errorMessage}` : null;
  const priceFor = (address: Address) => usdPriceFor(usdPrices, address);
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
            quoteState={quoteState}
            isConnected={isConnected}
            balanceKnown={sellsNative ? nativeBalance.data !== undefined : tokenInBalance !== undefined}
            onConnect={openWalletDialog}
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

`launch-detail.tsx` still imports `CurveTradePanel` until Task 12 — to keep this commit green, do the deletion in Task 12's commit instead. In this task only create the new files.

- [ ] **Step 6: Commit**

```bash
git add src/trading/curve-swap-panel.tsx src/trading/curve-swap-panel.test.tsx
git commit -m "feat: add CurveSwapPanel merging curve buy and sell into one swap panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Wire everything in, update the preview, remove old panels

**Files:**
- Modify: `fe/src/trading/swap-panel-preview.tsx`, `fe/src/features/launch/launch-detail.tsx`, `fe/src/features/pools/swap-trigger.tsx`
- Modify (tests): `fe/src/features/launch/launch-detail.test.tsx`, plus a new `fe/src/trading/swap-panel-preview.test.tsx`
- Delete: `fe/src/trading/buy-panel.tsx`, `buy-panel.test.tsx`, `sell-panel.tsx`, `sell-panel.test.tsx`, `curve-trade-panel.tsx`, `curve-trade-panel.test.tsx`

**Interfaces:**
- Consumes: `CurveSwapPanel`, `SwapPanel`, `V4SwapPanel` (Tasks 9–11), `TradeCard`, `SwapShell`.
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
In `launch-detail.test.tsx`: update any assertion that looked for `Buy`/`Sell` tabs of the curve panel to look for the single `Swap` panel (`getByText('Bonding curve')` badge, `getByLabelText('Sell amount')`); add tests that, for a curve launch with `priceUsd: '2'` and `quotePriceUsd: '3000'` (native-ETH quote): typing `0.001` in `Sell amount` (the quote side) shows `$3.00`; flipping and typing `3` shows `$6.00` on the launched-token side; and with `quotePriceUsd: null` the quote side shows no `$` line while the launched-token side still does.

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
  usdPrices={usdPrices}
/>
```
and pass `usdPrices={usdPrices}` to the existing `SwapPanel` (V3) and `V4SwapPanel` blocks. Define once near the top of `LaunchDetail`: `const usdPrices: UsdPrices = { [detail.tokenAddress.toLowerCase()]: detail.priceUsd ?? null, [detail.quoteAsset.address.toLowerCase()]: detail.quotePriceUsd ?? null };` (import `UsdPrices` from `@/trading/trade-usd`; `quotePriceUsd` exists after Task 5's regenerated `fe/src/api/schema.ts`). The V3 panel's WETH leg and the V4 native-ETH leg both use the quote asset's address, so both resolve to `quotePriceUsd`. Replace the import of `CurveTradePanel` with `CurveSwapPanel`. For the V4 block, add `logoUri` to the launch-token side only: `{ …, logoUri: detail.logoUri }` on whichever of `tokenA`/`tokenB` is the launched token (it is the side where the address equals `detail.tokenAddress`).

`swap-trigger.tsx`: change `<Dialog … title="Swap">` to `title={`${tokenA.symbol ?? 'Token'} / ${tokenB.symbol ?? 'Token'}`}` (the panel now renders its own "Swap" heading). Pass nothing else — the Pools page does not pass `usdPrices`, so its `$` lines stay hidden (see the spec's follow-up note).

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

### Task 13: Playwright smoke

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

### Task 14: Live verification (report, no code unless a bug is found)

**Files:** none unless a defect is found (then fix it with a test in the owning task's file).

- [ ] **Step 1:** Run `npm run dev` in `fe/` with the BE running (`be/`), open a launch whose official venue is the **active bonding curve**, connect a funded test wallet (Robinhood Chain 4663).
- [ ] **Step 2:** Use the curves verified on 2026-10-09 (all `graduated() == false` on chain 4663): **PROMETHEUS** (SPCX-quoted, token `0xeac1200c…e467`, curve `0x5bdcddef…36b4`, real depth), **OBUL** (ETH-quoted, token `0xcc71199b…bd8`, curve `0x4075be45…f948`), **GB** (USDG-quoted, token `0xdb348877…19e1`, curve `0xc23b1d11…9c9c`, almost no activity — `sell` there reverts by design). Compare against Pons's own trade page and Uniswap's swap panel (both `$` lines should appear, and their gap should roughly equal price impact + fees; for a tiny trade the two `$` values should be nearly equal) (`https://www.ponsfamily.com/launchpad/<token>`): e.g. Pons shows 27.28M PROMETHEUS for 1 SPCX; so must this app's forward quote.
  For each of native-ETH buy, ERC20-quoted buy, and sell, record: does typing in **Buy** fill **Sell** *before* the curve is approved and *without* a connected wallet; how many `eth_call` requests per search (DevTools → Network, filter `eth_call`) and the time from the last keystroke to the derived amount; how many requests the one-time slot discovery for each token costs.
- [ ] **Step 2b:** Walk the button on a real page: disconnected → `Connect` (click opens the wallet dialog); connected with an amount typed → `Getting quote…` for a moment; an amount larger than the wallet's balance of the sold token → `Not enough ETH` (or the sold token's symbol); a covered amount → `Swap`; typing in Buy → `Getting quote…` until Sell fills.
- [ ] **Step 3:** Repeat on a graduated V3 launch (expect one `quoteExactOutputSingle` call) and a graduated V4 launch / a Pools-page V4 pool (expect a short parallel `quoteExactInputSingleV4` search). Check that the public RPC does not throttle the parallel requests (no 429s); if it does, report the numbers before changing `SOLVER_WIDE_POINTS` / `SOLVER_REFINE_POINTS`.
- [ ] **Step 4:** Append the measured numbers to the spec under "Two-way quoting" (a short "Measured" paragraph), commit that doc only. If curve latency exceeds ~3 s, tune the constants in `solve-input-for-output.ts` (with a test) or report the numbers to the user before changing them.
- [ ] **Step 5:** Final check: `npx vitest run && npx tsc --noEmit && npx eslint .` in `fe/`; report any test or lint failure verbatim.

---

## Self-Review (done)

- **Spec coverage:** parallel solver incl. dust handling and guess (Task 1); state-override slot discovery (Task 2); closed-form guess (Task 3); per-venue reverse builders — V3 single call, V4/curve search, synthetic account (Task 4); quote-asset USD price in the API (Task 5); two-way state, flip semantics, debounce/abort (Task 6); TradeCard/SwapShell + Min received + `$` lines on both cards (Task 7); button states Connect / Getting quote… / Not enough X / Swap and the open-wallet-dialog request (Task 8); V3/V4 migration (Tasks 9–10); `CurveSwapPanel` replacing Buy/Sell/CurveTrade with ported regression tests (Task 11); wiring, preview, deletions (Task 12); e2e (Task 13); live verification and measurement (Task 14).
- **Placeholders:** none — the places that say "copy verbatim from buy-panel.tsx" (submission/batch hook boilerplate), "read the submitted call the way the existing tests do", and "insert a launch the way this file's beforeAll does" point to existing files the engineer reads, and name exactly which parts.
- **Type consistency:** `QuoteFn` (Task 1), `CallClient`/`SIMULATION_ACCOUNT`/`Erc20Layouts` (Task 2), `CurveState` (Task 3), `ReverseSolve` and the three `make…ReverseSolve` signatures (Task 4), `LaunchDetail.quotePriceUsd` (Task 5), `ReverseStatus`/`useSwapAmounts` fields (`sellText`, `buyTypedText`, `amountIn`, `reverseStatus`, `onSellChange`, `onBuyChange`, `flip`, `reset`) (Task 6), `TradeCardSide`/`minReceived`/`UsdPrices`/`usdPriceFor` (Task 7), `QuoteState`/`resolveTradeButton`/`deriveQuoteState`/`openWalletDialog` and the new `ApproveOrActionButton` props `quoteState`, `isConnected`, `balanceKnown`, `onConnect` (Task 8) are used with identical names and shapes in Tasks 9–12.
- **Known risks called out, not hidden:** (1) a token whose storage layout is not discovered (e.g. a proxy) has no reverse quote on the curve — verified layouts: USDG, Pons launch tokens, stock tokens; (2) during a launch's first seconds (snipe tax) the synthetic account may be quoted differently than the user's account, so the forward quote at the derived input (real account) remains the authority for "Min received" and submission; (3) forward quotes for ERC20-quoted buy/sell still need approval first (existing behavior), so for such a launch the button can read "Quote unavailable" or "Approve" before approval — extending the same state-override trick to the forward quote is a natural follow-up; (4) parallel probing sends up to 16 `eth_call`s per round to the RPC — Task 14 checks for throttling; (5) the working tree has unrelated uncommitted changes in files this plan edits (including `wallet-control.tsx` and `approve-or-action-button.tsx`) — commits must stage only their own hunks; (6) the Pools page does not get `$` lines yet (no per-currency USD prices there) — a follow-up; (7) the panel's Connect button reaches the header's wallet dialog through a window event, so it needs `WalletControl` mounted (it is, in `AppShell` on every page).
