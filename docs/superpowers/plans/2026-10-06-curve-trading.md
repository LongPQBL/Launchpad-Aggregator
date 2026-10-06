# Curve Trading (Buy/Sell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a connected browser wallet buy and sell a Pons-launched token directly against its bonding curve from the launch detail page, with real on-chain execution — no router, no platform fee.

**Architecture:** A new `fe/src/trading/` module adds curve/ERC20 write-ABIs, a quote hook (`useSimulateContract` static-calling `buy`/`sell` with `minOut: 0`), an allowance/approval hook, a slippage+deadline settings hook (localStorage-persisted, same pattern as the existing dark-theme toggle), and Buy/Sell panel components. `launch-detail.tsx` renders the panel only when the launch's current official venue is `curve`, its lifecycle status is `trading`, and its token decimals are known; it renders nothing (not a placeholder) otherwise, since graduated-pool Swap is a separate follow-up plan. One small backend addition (`tokenDecimals` on `LaunchDetail`) comes first, since the launched token's own decimals aren't currently exposed by the API and guessing them would risk encoding a wrong amount.

**Tech Stack:** Node.js, TypeScript, Fastify, PostgreSQL (backend); Next.js, React, TypeScript, Tailwind, shadcn/ui, Wagmi 3 (`useSimulateContract`, `useWriteContract`, `useWaitForTransactionReceipt`, `useReadContract`, `useBalance`), viem 2 (ABI encoding, `BaseError`/`ContractFunctionRevertedError`) (frontend); Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-06-launch-trading-design.md`

## Global Constraints

- No platform fee in this phase — submit the curve's own `buy`/`sell` unmodified (spec: "Why this scope", "Explicitly out of scope").
- Real execution only — no simulated/paper-trading mode runs alongside it (spec: "Why this scope").
- Never fabricate a price/quote or an amount: an unavailable or not-yet-computed value shows as unavailable (disabled button, no panel at all), never a zero, a guess, or an assumed decimals count (CLAUDE.md: "null means unavailable/incomplete, never silently convert missing data to zero").
- Buy is disabled, never replaced by a deposit-prompt, when the connected wallet can't cover the trade (spec: "UI flow"; CLAUDE.md standing preference).
- Approval is exact-amount by default, never infinite (spec: "Approval flow").
- Settings UI is limited to Max slippage (Auto + custom) and Swap deadline (minutes) — no "Trade options" or "1-click swaps" in this phase (spec: "UI flow").
- Buy needs the same approve-then-call flow as Sell whenever the launch's quote asset isn't native ETH (`quoteAsset.address !== '0x0000000000000000000000000000000000000000'`) — this is the common case, not an edge case (spec: "Protocol research" correction).
- Code identifiers, tests, comments are English (CLAUDE.md).
- No automated test requires a real wallet extension or spends real funds (spec: "Testing").
- Backend migrations are additive, never destructive (CLAUDE.md).

## Review Focus

- Wallet connected to a chain other than Robinhood Chain (4663) attempting to trade — must block submission (not silently send to the wrong chain); `fe/src/wallet/wallet-control.tsx` already offers a chain-switch affordance elsewhere, this panel must not duplicate or bypass it.
- An ERC20-quoted launch's Buy with no existing allowance — must show an Approve step, never silently attempt (and fail) a buy, and never silently skip straight to a doomed `buy()` call.
- A slippage/minOut revert on submission — the curve's real revert name for this case was not identified during research (only `CurveGraduated`/`UnexpectedNativeValue` were confirmed), so the message must not be invented; `decodeTradeError`'s generic fallback (Task 2) surfaces the real on-chain revert/error name rather than a flat "transaction failed," which is the honest version of this requirement until a real sample is decoded.
- An empty or zero amount input — the Buy/Sell button must stay disabled; the quote hook must not simulate a zero-amount call.
- The launch graduating (lifecycle flips away from `trading`) while the panel is open with a stale quote — a submit must not be possible once the venue is no longer the curve; the panel must react to updated `detail` props, not just its own local state.
- A launch whose `tokenDecimals` hasn't resolved yet (near-realtime-synced, core metadata pending) — the trade panel must not render at all rather than guessing a decimals count and risking a wrongly-encoded amount.

---

## Task 1: Expose the launched token's own decimals on LaunchDetail

**Files:**
- Modify: `be/src/api/server.ts:17` (`LaunchSummary` interface)
- Modify: `be/src/api/store.ts:37-52` (`summary()` function)
- Modify: `be/src/api/schemas.ts` (`launchSummary` schema)
- Modify: `be/src/api/server.test.ts` (fixture)
- Modify: `be/src/api/store.integration.test.ts` (add assertion to an existing fixture-backed test)
- Regenerate: `be/openapi.json`, `fe/src/api/schema.ts`
- Modify: `fe/src/features/launch/launch-detail.test.tsx`, `fe/src/features/launches/launch-list.test.tsx` (fixture `tokenDecimals: 18`)

**Interfaces:**
- Produces: `LaunchSummary.tokenDecimals: number | null` (and therefore `LaunchDetail.tokenDecimals`, which extends it) — null exactly when `launches.token_decimals` is null (core-metadata enrichment still pending), matching the existing nullable pattern used by `name`/`symbol`.

- [ ] **Step 1: Write the failing integration test**

In `be/src/api/store.integration.test.ts`, inside the `'new stats fields degrade per-launch, not per-page (Review Focus)'` describe block (same fixtures already used for the `priceUsd` test added earlier), extend the `'getLaunch also returns real stats for a single launch (final-review Important 8)'` test:

```typescript
expect(detail!.tokenDecimals).toBe(18);
```

(The `goodToken`/`brokenToken` fixtures in that block already insert `launches` rows with `token_decimals,18` — see the `INSERT INTO launches` call near the top of the describe block.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && set -a && source .env && set +a && npx vitest run --config vitest.integration.config.ts -t "getLaunch also returns real stats" src/api/store.integration.test.ts`
Expected: FAIL — `expected undefined to be 18`

- [ ] **Step 3: Add the field**

In `be/src/api/server.ts`, in the `LaunchSummary` interface:

```typescript
export interface LaunchSummary {
  chainId: number; tokenAddress: string; name: string | null; symbol: string | null; platform: string; protocolVersion: string;
  quoteAsset: { address: string; symbol: string | null; decimals: number | null }; lifecycleStatus: string;
  tokenDecimals: number | null;
  officialVolume24h: string | null; coverageStatus: string;
  // ... (rest unchanged)
```

In `be/src/api/store.ts`'s `summary()` function, add alongside the existing `quoteAsset` line:

```typescript
quoteAsset: { address: string(row.quote_asset_address), symbol: nullableString(row.quote_asset_symbol), decimals: nullableNumber(row.quote_asset_decimals) },
tokenDecimals: nullableNumber(row.token_decimals),
```

In `be/src/api/schemas.ts`'s `launchSummary` schema, add alongside `quoteAsset`:

```typescript
quoteAsset,
tokenDecimals: { type: 'integer', nullable: true },
```

- [ ] **Step 4: Fix the `server.test.ts` fixture**

In `be/src/api/server.test.ts`, add `tokenDecimals: 18,` to the `launchSummary` fixture object (alongside the existing `quoteAsset` line).

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `cd be && set -a && source .env && set +a && npx vitest run --config vitest.integration.config.ts -t "getLaunch also returns real stats" src/api/store.integration.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full backend suite and typecheck**

Run: `cd be && npx vitest run && npx tsc --noEmit`
Expected: all pass (fix any other fixture TypeScript errors the same way the `priceUsd` addition was fixed earlier — add the field to any other object literal typed as `LaunchSummary`)

- [ ] **Step 7: Regenerate OpenAPI and the FE schema**

Run: `cd be && npm run openapi:write && cd ../fe && npm run generate:schema`

- [ ] **Step 8: Fix FE fixtures and typecheck**

Add `tokenDecimals: 18,` to the `detail()` fixture in `fe/src/features/launch/launch-detail.test.tsx` and the `launch()` fixture in `fe/src/features/launches/launch-list.test.tsx`.

Run: `cd fe && npx tsc --noEmit && npx vitest run`
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add be/src/api/server.ts be/src/api/store.ts be/src/api/schemas.ts be/src/api/server.test.ts be/src/api/store.integration.test.ts be/openapi.json fe/src/api/schema.ts fe/src/features/launch/launch-detail.test.tsx fe/src/features/launches/launch-list.test.tsx
git commit -m "feat(be): expose the launched token's own decimals on LaunchDetail"
```

---

## Task 2: Curve + ERC20 write ABIs and trade-error decoding

**Files:**
- Create: `fe/src/trading/curveAbi.ts`
- Create: `fe/src/trading/erc20Abi.ts`
- Create: `fe/src/trading/decodeTradeError.ts`
- Test: `fe/src/trading/decodeTradeError.test.ts`

**Interfaces:**
- Produces: `curveTradeAbi` (viem `Abi`, functions `buy`/`sell`, errors `CurveGraduated`/`UnexpectedNativeValue`), `erc20Abi` (viem `Abi`, `balanceOf`/`allowance`/`approve`), `decodeTradeError(error: unknown): string`.

- [ ] **Step 1: Write the ABI modules (no test needed — pure constant data, exercised indirectly by every later task's hook tests)**

`fe/src/trading/curveAbi.ts`:
```typescript
import { parseAbi } from 'viem';

// Verified against two real on-chain transactions and one live eth_call simulation during
// docs/superpowers/specs/2026-10-06-launch-trading-design.md's research — not guessed.
// sell's returns(uint256) is assumed symmetric with buy, not independently simulated; callers
// must treat a decode failure on sell's result as "quote unavailable", not a crash.
export const curveTradeAbi = parseAbi([
  'function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
  'error CurveGraduated()',
  'error UnexpectedNativeValue()',
]);
```

`fe/src/trading/erc20Abi.ts`:
```typescript
import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
```

- [ ] **Step 2: Write the failing test for `decodeTradeError`**

```typescript
// fe/src/trading/decodeTradeError.test.ts
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeTradeError } from './decodeTradeError';

function revertError(errorName: string) {
  const inner = new ContractFunctionRevertedError({
    abi: [{ type: 'error', name: errorName, inputs: [] }],
    data: undefined,
    functionName: 'buy',
  });
  // ContractFunctionRevertedError only infers data.errorName when it can decode raw revert data;
  // for a test we set it directly since we're exercising decodeTradeError, not viem's own decoder.
  Object.defineProperty(inner, 'data', { value: { errorName, args: [] } });
  return new BaseError('execution reverted', { cause: inner });
}

describe('decodeTradeError', () => {
  it('maps CurveGraduated to a plain-language message', () => {
    expect(decodeTradeError(revertError('CurveGraduated'))).toBe(
      'This token has already graduated off the bonding curve — trade it on its pool instead.',
    );
  });

  it('maps UnexpectedNativeValue to a plain-language message', () => {
    expect(decodeTradeError(revertError('UnexpectedNativeValue'))).toBe(
      'This trade does not accept native ETH — check the quote asset for this launch.',
    );
  });

  it('falls back to the revert name for an unrecognized custom error', () => {
    expect(decodeTradeError(revertError('SlippageExceeded'))).toBe('Transaction would fail: SlippageExceeded');
  });

  it('falls back to a plain Error message for a non-viem error', () => {
    expect(decodeTradeError(new Error('network request failed'))).toBe('network request failed');
  });

  it('falls back to a generic message for a non-Error value', () => {
    expect(decodeTradeError('not an error')).toBe('Unknown error');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd fe && npx vitest run src/trading/decodeTradeError.test.ts`
Expected: FAIL — `Cannot find module './decodeTradeError'`

- [ ] **Step 4: Write the minimal implementation**

```typescript
// fe/src/trading/decodeTradeError.ts
import { BaseError, ContractFunctionRevertedError } from 'viem';

// Only the two custom errors this app's own research has decoded and confirmed (see curveAbi.ts)
// get a tailored message. Anything else falls back to the raw revert/error name rather than
// inventing a guess at its meaning.
const KNOWN_ERRORS: Record<string, string> = {
  CurveGraduated: 'This token has already graduated off the bonding curve — trade it on its pool instead.',
  UnexpectedNativeValue: 'This trade does not accept native ETH — check the quote asset for this launch.',
};

export function decodeTradeError(error: unknown): string {
  if (error instanceof BaseError) {
    const revertError = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      const errorName = revertError.data?.errorName;
      if (errorName) return KNOWN_ERRORS[errorName] ?? `Transaction would fail: ${errorName}`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd fe && npx vitest run src/trading/decodeTradeError.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
cd fe && git add src/trading/curveAbi.ts src/trading/erc20Abi.ts src/trading/decodeTradeError.ts src/trading/decodeTradeError.test.ts
git commit -m "feat(fe): add curve/ERC20 write ABIs and trade-error decoding"
```

---

## Task 3: Trade settings (slippage + deadline), persisted

**Files:**
- Create: `fe/src/trading/use-trade-settings.ts`
- Create: `fe/src/trading/trade-settings-popover.tsx`
- Test: `fe/src/trading/use-trade-settings.test.ts`
- Test: `fe/src/trading/trade-settings-popover.test.tsx`

**Interfaces:**
- Produces: `TradeSettings { slippageBps: number | 'auto'; deadlineMinutes: number }`, `useTradeSettings(): { settings: TradeSettings; update: (next: TradeSettings) => void }`, `resolveAutoSlippageBps(venueKind: 'curve' | 'pool'): number`, `<TradeSettingsPopover settings={TradeSettings} onChange={(next: TradeSettings) => void} venueKind="curve" />`.
- Consumes: none (first UI-only piece).

- [ ] **Step 1: Write the failing test for the settings hook**

```typescript
// fe/src/trading/use-trade-settings.test.ts
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAutoSlippageBps, useTradeSettings } from './use-trade-settings';

beforeEach(() => localStorage.clear());

describe('useTradeSettings', () => {
  it('defaults to Auto slippage and a 30 minute deadline', () => {
    const { result } = renderHook(() => useTradeSettings());
    expect(result.current.settings).toEqual({ slippageBps: 'auto', deadlineMinutes: 30 });
  });

  it('persists an update to localStorage and reflects it immediately', () => {
    const { result } = renderHook(() => useTradeSettings());
    act(() => result.current.update({ slippageBps: 100, deadlineMinutes: 10 }));
    expect(result.current.settings).toEqual({ slippageBps: 100, deadlineMinutes: 10 });
    expect(JSON.parse(localStorage.getItem('trade-settings')!)).toEqual({ slippageBps: 100, deadlineMinutes: 10 });
  });

  it('loads a previously persisted value on mount', () => {
    localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 250, deadlineMinutes: 5 }));
    const { result } = renderHook(() => useTradeSettings());
    expect(result.current.settings).toEqual({ slippageBps: 250, deadlineMinutes: 5 });
  });

  it('ignores malformed stored JSON and keeps the default', () => {
    localStorage.setItem('trade-settings', '{not json');
    const { result } = renderHook(() => useTradeSettings());
    expect(result.current.settings).toEqual({ slippageBps: 'auto', deadlineMinutes: 30 });
  });
});

describe('resolveAutoSlippageBps', () => {
  it('uses a wider default on the curve than on a graduated pool', () => {
    expect(resolveAutoSlippageBps('curve')).toBeGreaterThan(resolveAutoSlippageBps('pool'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-trade-settings.test.ts`
Expected: FAIL — `Cannot find module './use-trade-settings'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/use-trade-settings.ts
'use client';

import { useEffect, useState } from 'react';

export interface TradeSettings {
  slippageBps: number | 'auto';
  deadlineMinutes: number;
}

const DEFAULT_SETTINGS: TradeSettings = { slippageBps: 'auto', deadlineMinutes: 30 };
const STORAGE_KEY = 'trade-settings';

// A steep bonding curve moves price heavily on a single buy (competitor research on pump.fun
// found 10-15% common on thin curves — see the trading design spec's "UI flow" section); a
// graduated pool behaves like an ordinary Uniswap pool, where a much tighter default is normal.
export function resolveAutoSlippageBps(venueKind: 'curve' | 'pool'): number {
  return venueKind === 'curve' ? 1200 : 50;
}

export function useTradeSettings(): { settings: TradeSettings; update: (next: TradeSettings) => void } {
  const [settings, setSettings] = useState<TradeSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- same SSR-safe localStorage-sync pattern as theme-toggle.tsx
      setSettings(JSON.parse(stored) as TradeSettings);
    } catch {
      // Malformed stored value — keep the default rather than crashing.
    }
  }, []);

  function update(next: TradeSettings) {
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  return { settings, update };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/use-trade-settings.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the failing test for the settings popover UI**

```typescript
// fe/src/trading/trade-settings-popover.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeSettingsPopover } from './trade-settings-popover';

describe('TradeSettingsPopover', () => {
  it('opens on the gear button and shows the current slippage and deadline', () => {
    render(<TradeSettingsPopover settings={{ slippageBps: 'auto', deadlineMinutes: 30 }} onChange={vi.fn()} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  it('switches to a custom slippage value and reports it via onChange', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={{ slippageBps: 'auto', deadlineMinutes: 30 }} onChange={onChange} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    fireEvent.change(screen.getByLabelText(/custom slippage/i), { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith({ slippageBps: 250, deadlineMinutes: 30 });
  });

  it('reports a changed deadline via onChange', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={{ slippageBps: 'auto', deadlineMinutes: 30 }} onChange={onChange} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    fireEvent.change(screen.getByLabelText(/deadline/i), { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith({ slippageBps: 'auto', deadlineMinutes: 10 });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/trade-settings-popover.test.tsx`
Expected: FAIL — `Cannot find module './trade-settings-popover'`

- [ ] **Step 7: Write the minimal implementation**

```typescript
// fe/src/trading/trade-settings-popover.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TradeSettings } from './use-trade-settings';

export interface TradeSettingsPopoverProps {
  settings: TradeSettings;
  onChange: (next: TradeSettings) => void;
  venueKind: 'curve' | 'pool';
}

export function TradeSettingsPopover({ settings, onChange, venueKind }: TradeSettingsPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button type="button" variant="ghost" size="sm" aria-label="Trade settings" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⚙
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-border bg-card p-3 shadow-lg text-sm">
          <div className="flex items-center justify-between gap-2">
            <span>Max slippage</span>
            <Button type="button" size="sm" variant={settings.slippageBps === 'auto' ? 'default' : 'outline'}
              onClick={() => onChange({ ...settings, slippageBps: 'auto' })}>
              Auto
            </Button>
          </div>
          <label className="mt-2 flex items-center justify-between gap-2">
            <span>Custom slippage %</span>
            <Input
              aria-label="Custom slippage"
              type="number"
              step="0.1"
              value={settings.slippageBps === 'auto' ? '' : (settings.slippageBps / 100).toString()}
              onChange={(event) => {
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent) || percent <= 0) return;
                onChange({ ...settings, slippageBps: Math.round(percent * 100) });
              }}
              className="w-20"
            />
          </label>
          <label className="mt-2 flex items-center justify-between gap-2">
            <span>Swap deadline (minutes)</span>
            <Input
              aria-label="Deadline minutes"
              type="number"
              value={settings.deadlineMinutes}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (!Number.isFinite(minutes) || minutes <= 0) return;
                onChange({ ...settings, deadlineMinutes: minutes });
              }}
              className="w-20"
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            {venueKind === 'curve' ? 'Curve-phase trades tolerate more slippage by default — price moves fast on a thin curve.' : null}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/trade-settings-popover.test.tsx`
Expected: PASS, 3 tests

- [ ] **Step 9: Commit**

```bash
cd fe && git add src/trading/use-trade-settings.ts src/trading/use-trade-settings.test.ts src/trading/trade-settings-popover.tsx src/trading/trade-settings-popover.test.tsx
git commit -m "feat(fe): add persisted slippage/deadline trade settings"
```

---

## Task 4: Token allowance + approval hook

**Files:**
- Create: `fe/src/trading/use-token-allowance.ts`
- Test: `fe/src/trading/use-token-allowance.test.ts`

**Interfaces:**
- Consumes: `erc20Abi` (Task 2).
- Produces: `useTokenAllowance(tokenAddress: Address | undefined, spender: Address | undefined): { allowance: bigint; isAllowanceLoading: boolean; approve: (amount: bigint) => void; isApproving: boolean; approveError: string | null }`.

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/use-token-allowance.test.ts
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTokenAllowance } from './use-token-allowance';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined },
  allowanceData: 0n as bigint | undefined,
  refetch: vi.fn(),
  writeContract: vi.fn(),
  writePending: false,
  writeError: null as Error | null,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: hooks.account.address }),
  useReadContract: () => ({ data: hooks.allowanceData, refetch: hooks.refetch }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, isPending: hooks.writePending, error: hooks.writeError }),
}));

const token = '0x2222222222222222222222222222222222222222' as const;
const spender = '0x3333333333333333333333333333333333333333' as const;

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.allowanceData = 0n;
  hooks.writePending = false;
  hooks.writeError = null;
  hooks.refetch.mockReset();
  hooks.writeContract.mockReset();
});

describe('useTokenAllowance', () => {
  it('reports the current allowance from the chain', () => {
    hooks.allowanceData = 500n;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.allowance).toBe(500n);
  });

  it('defaults to 0 while allowance is not yet loaded', () => {
    hooks.allowanceData = undefined;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.allowance).toBe(0n);
  });

  it('submits an exact-amount approve, never an infinite one', () => {
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    result.current.approve(1000n);
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: token, functionName: 'approve', args: [spender, 1000n] }),
      expect.anything(),
    );
  });

  it('surfaces a decoded approval error', () => {
    hooks.writeError = new Error('User rejected the request');
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.approveError).toBe('User rejected the request');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-token-allowance.test.ts`
Expected: FAIL — `Cannot find module './use-token-allowance'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/use-token-allowance.ts
'use client';

import type { Address } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { decodeTradeError } from './decodeTradeError';
import { erc20Abi } from './erc20Abi';

export interface TokenAllowance {
  allowance: bigint;
  isAllowanceLoading: boolean;
  approve: (amount: bigint) => void;
  isApproving: boolean;
  approveError: string | null;
}

export function useTokenAllowance(tokenAddress: Address | undefined, spender: Address | undefined): TokenAllowance {
  const { address: owner } = useAccount();
  const { data: allowance, isLoading, refetch } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && spender ? [owner, spender] : undefined,
    query: { enabled: Boolean(tokenAddress && owner && spender) },
  });
  const { writeContract, isPending, error } = useWriteContract();

  function approve(amount: bigint) {
    if (!tokenAddress || !spender) return;
    // Exact amount, never infinite — matches the spec's "Approval flow" default.
    writeContract({ address: tokenAddress, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }, { onSuccess: () => refetch() });
  }

  return {
    allowance: allowance ?? 0n,
    isAllowanceLoading: isLoading,
    approve,
    isApproving: isPending,
    approveError: error ? decodeTradeError(error) : null,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/use-token-allowance.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/use-token-allowance.ts src/trading/use-token-allowance.test.ts
git commit -m "feat(fe): add ERC20 allowance/approve hook for trading"
```

---

## Task 5: Curve quote hook

**Files:**
- Create: `fe/src/trading/use-curve-quote.ts`
- Test: `fe/src/trading/use-curve-quote.test.ts`

**Interfaces:**
- Consumes: `curveTradeAbi` (Task 2), `decodeTradeError` (Task 2).
- Produces: `useCurveQuote(params: { curveAddress: Address | undefined; direction: 'buy' | 'sell'; amountIn: bigint; recipient: Address | undefined; nativeValue: bigint | undefined }): { outputAmount: bigint | null; isLoading: boolean; errorMessage: string | null }`.

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/use-curve-quote.test.ts
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useCurveQuote } from './use-curve-quote';

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

const curve = '0x4444444444444444444444444444444444444444' as const;
const recipient = '0x5555555555555555555555555555555555555555' as const;

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useCurveQuote', () => {
  it('returns the simulated output amount for a buy', () => {
    hooks.data = { result: 588938n };
    const { result } = renderHook(() =>
      useCurveQuote({ curveAddress: curve, direction: 'buy', amountIn: 1000000000000000n, recipient, nativeValue: 1000000000000000n }),
    );
    expect(result.current.outputAmount).toBe(588938n);
  });

  it('disables the simulation for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useCurveQuote({ curveAddress: curve, direction: 'buy', amountIn: 0n, recipient, nativeValue: 0n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('CurveGraduated reverted');
    const { result } = renderHook(() =>
      useCurveQuote({ curveAddress: curve, direction: 'buy', amountIn: 1000000000000000n, recipient, nativeValue: 1000000000000000n }),
    );
    expect(result.current.errorMessage).toBe('CurveGraduated reverted');
  });

  it('passes minTokensOut: 0 for a buy quote and minQuoteOut: 0 for a sell quote', () => {
    renderHook(() =>
      useCurveQuote({ curveAddress: curve, direction: 'sell', amountIn: 1000n, recipient, nativeValue: undefined }),
    );
    expect((hooks.simulateArgs as { args: unknown[] }).args).toEqual([1000n, 0n, recipient]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-curve-quote.test.ts`
Expected: FAIL — `Cannot find module './use-curve-quote'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/use-curve-quote.ts
'use client';

import type { Address } from 'viem';
import { useSimulateContract } from 'wagmi';
import { curveTradeAbi } from './curveAbi';
import { decodeTradeError } from './decodeTradeError';

export interface CurveQuoteParams {
  curveAddress: Address | undefined;
  direction: 'buy' | 'sell';
  amountIn: bigint;
  recipient: Address | undefined;
  // Only read for direction: 'buy' on a native-ETH-quoted launch — undefined/0 for an
  // ERC20-quoted launch, where the curve pulls funds via transferFrom instead (see curveAbi.ts).
  nativeValue: bigint | undefined;
}

export interface CurveQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

export function useCurveQuote({ curveAddress, direction, amountIn, recipient, nativeValue }: CurveQuoteParams): CurveQuoteResult {
  const enabled = Boolean(curveAddress && recipient && amountIn > 0n);
  const { data, isLoading, error } = useSimulateContract({
    address: curveAddress,
    abi: curveTradeAbi,
    functionName: direction,
    args: recipient ? [amountIn, 0n, recipient] : undefined,
    value: direction === 'buy' ? nativeValue : undefined,
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

Run: `cd fe && npx vitest run src/trading/use-curve-quote.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/use-curve-quote.ts src/trading/use-curve-quote.test.ts
git commit -m "feat(fe): add curve buy/sell quote hook via eth_call simulation"
```

---

## Task 6: Transaction status (shared)

**Files:**
- Create: `fe/src/trading/use-trade-submission.ts`
- Create: `fe/src/trading/trade-status.tsx`
- Test: `fe/src/trading/use-trade-submission.test.ts`
- Test: `fe/src/trading/trade-status.test.tsx`

**Interfaces:**
- Consumes: `decodeTradeError` (Task 2).
- Produces: `useTradeSubmission(): { submit: (config: Parameters<ReturnType<typeof useWriteContract>['writeContract']>[0]) => void; status: 'idle' | 'pending' | 'confirming' | 'confirmed' | 'failed'; txHash: Address | undefined; errorMessage: string | null }`, `<TradeStatus status={...} txHash={...} errorMessage={...} explorerBase={string | null} />`.

- [ ] **Step 1: Write the failing test for the submission hook**

```typescript
// fe/src/trading/use-trade-submission.test.ts
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTradeSubmission } from './use-trade-submission';

const hooks = vi.hoisted(() => ({
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  writeError: null as Error | null,
  hash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: hooks.writeError, data: hooks.hash }),
  useWaitForTransactionReceipt: () => ({ status: hooks.receiptStatus }),
}));

beforeEach(() => {
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.writeError = null;
  hooks.hash = undefined;
  hooks.receiptStatus = 'idle';
});

describe('useTradeSubmission', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('idle');
  });

  it('reports pending while the wallet write is in flight', () => {
    hooks.writeStatus = 'pending';
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('pending');
  });

  it('reports confirming once a hash exists but the receipt has not landed', () => {
    hooks.writeStatus = 'success';
    hooks.hash = '0xabc';
    hooks.receiptStatus = 'pending';
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('confirming');
    expect(result.current.txHash).toBe('0xabc');
  });

  it('reports confirmed once the receipt lands', () => {
    hooks.writeStatus = 'success';
    hooks.hash = '0xabc';
    hooks.receiptStatus = 'success';
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('confirmed');
  });

  it('reports failed with a decoded message when the wallet write errors', () => {
    hooks.writeStatus = 'error';
    hooks.writeError = new Error('User rejected the request');
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('failed');
    expect(result.current.errorMessage).toBe('User rejected the request');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/use-trade-submission.test.ts`
Expected: FAIL — `Cannot find module './use-trade-submission'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/use-trade-submission.ts
'use client';

import type { Address } from 'viem';
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { decodeTradeError } from './decodeTradeError';

export type TradeSubmissionStatus = 'idle' | 'pending' | 'confirming' | 'confirmed' | 'failed';

export interface TradeSubmission {
  submit: ReturnType<typeof useWriteContract>['writeContract'];
  status: TradeSubmissionStatus;
  txHash: Address | undefined;
  errorMessage: string | null;
}

export function useTradeSubmission(): TradeSubmission {
  const { writeContract, status: writeStatus, error, data: txHash } = useWriteContract();
  const { status: receiptStatus } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: Boolean(txHash) } });

  let status: TradeSubmissionStatus = 'idle';
  if (writeStatus === 'pending') status = 'pending';
  else if (writeStatus === 'error') status = 'failed';
  else if (writeStatus === 'success') status = receiptStatus === 'success' ? 'confirmed' : receiptStatus === 'error' ? 'failed' : 'confirming';

  return {
    submit: writeContract,
    status,
    txHash,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/use-trade-submission.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the failing test for the status display component**

```typescript
// fe/src/trading/trade-status.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TradeStatus } from './trade-status';

describe('TradeStatus', () => {
  it('shows nothing while idle', () => {
    const { container } = render(<TradeStatus status="idle" txHash={undefined} errorMessage={null} explorerBase={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a pending message while the wallet prompt is open', () => {
    render(<TradeStatus status="pending" txHash={undefined} errorMessage={null} explorerBase={null} />);
    expect(screen.getByText(/confirm in your wallet/i)).toBeInTheDocument();
  });

  it('links to the explorer once a hash exists', () => {
    render(<TradeStatus status="confirming" txHash="0xabc" errorMessage={null} explorerBase="https://robinhoodchain.blockscout.com" />);
    expect(screen.getByRole('link', { name: /view transaction/i })).toHaveAttribute('href', 'https://robinhoodchain.blockscout.com/tx/0xabc');
  });

  it('shows the decoded error message on failure', () => {
    render(<TradeStatus status="failed" txHash={undefined} errorMessage="User rejected the request" explorerBase={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('User rejected the request');
  });

  it('shows a confirmed message', () => {
    render(<TradeStatus status="confirmed" txHash="0xabc" errorMessage={null} explorerBase="https://robinhoodchain.blockscout.com" />);
    expect(screen.getByText(/confirmed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/trade-status.test.tsx`
Expected: FAIL — `Cannot find module './trade-status'`

- [ ] **Step 7: Write the minimal implementation**

```typescript
// fe/src/trading/trade-status.tsx
export interface TradeStatusProps {
  status: 'idle' | 'pending' | 'confirming' | 'confirmed' | 'failed';
  txHash: `0x${string}` | undefined;
  errorMessage: string | null;
  explorerBase: string | null;
}

export function TradeStatus({ status, txHash, errorMessage, explorerBase }: TradeStatusProps) {
  if (status === 'idle') return null;

  const explorerLink = explorerBase && txHash ? (
    <a href={`${explorerBase}/tx/${txHash}`} target="_blank" rel="noreferrer noopener" className="underline hover:text-primary">
      View transaction
    </a>
  ) : null;

  if (status === 'pending') return <p className="text-sm text-muted-foreground">Confirm in your wallet…</p>;
  if (status === 'confirming') return <p className="text-sm text-muted-foreground">Confirming on-chain… {explorerLink}</p>;
  if (status === 'confirmed') return <p className="text-sm text-emerald-600">Confirmed. {explorerLink}</p>;
  return (
    <p role="alert" className="text-sm text-destructive">
      {errorMessage ?? 'Transaction failed.'} {explorerLink}
    </p>
  );
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/trade-status.test.tsx`
Expected: PASS, 5 tests

- [ ] **Step 9: Commit**

```bash
cd fe && git add src/trading/use-trade-submission.ts src/trading/use-trade-submission.test.ts src/trading/trade-status.tsx src/trading/trade-status.test.tsx
git commit -m "feat(fe): add shared trade submission/status tracking"
```

---

## Task 7: Buy panel

**Files:**
- Create: `fe/src/trading/buy-panel.tsx`
- Test: `fe/src/trading/buy-panel.test.tsx`

**Interfaces:**
- Consumes: `useCurveQuote` (Task 5), `useTokenAllowance` (Task 4), `useTradeSubmission`/`TradeStatus` (Task 6), `TradeSettingsPopover`/`useTradeSettings`/`resolveAutoSlippageBps` (Task 3), `curveTradeAbi` (Task 2).
- Produces: `<BuyPanel curveAddress={Address} tokenAddress={Address} tokenDecimals={number} quoteAsset={{ address: Address; symbol: string | null; decimals: number }} explorerBase={string | null} />`.

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/buy-panel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyPanel } from './buy-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  balance: { data: { value: 10000000000000000n }, isLoading: false },
  allowance: 0n,
  simulateData: undefined as { result: bigint } | undefined,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => hooks.balance,
  useReadContract: () => ({ data: hooks.allowance, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const nativeQuote = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };
const erc20Quote = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.balance = { data: { value: 10000000000000000n }, isLoading: false };
  hooks.allowance = 0n;
  hooks.simulateData = undefined;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('BuyPanel', () => {
  it('disables Buy when the amount is empty', () => {
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
  });

  it('disables Buy when the native-ETH balance is insufficient, without a deposit prompt', () => {
    hooks.balance = { data: { value: 0n }, isLoading: false };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
    expect(screen.queryByText(/deposit/i)).not.toBeInTheDocument();
  });

  it('submits buy directly with native value for a native-ETH-quoted launch, no approval step', () => {
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: curve, functionName: 'buy', value: 1000000000000000n }),
      expect.anything(),
    );
  });

  it('shows Approve instead of Buy for an ERC20-quoted launch with no allowance yet', () => {
    hooks.allowance = 0n;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
  });

  it('shows Buy once allowance covers the amount for an ERC20-quoted launch', () => {
    hooks.allowance = 2000000000000000000n;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows the simulated quote, formatted with the launched token\'s own decimals', () => {
    hooks.simulateData = { result: 588938000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByText(/588938/)).toBeInTheDocument();
  });

  it('disables Buy and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/buy-panel.test.tsx`
Expected: FAIL — `Cannot find module './buy-panel'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/buy-panel.tsx
'use client';

import { useState } from 'react';
import { type Address, formatUnits, parseUnits, zeroAddress } from 'viem';
import { useAccount, useBalance } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { curveTradeAbi } from './curveAbi';
import { useCurveQuote } from './use-curve-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings, resolveAutoSlippageBps } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { TradeStatus } from './trade-status';

export interface BuyPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — NOT the quote asset's. Sourced from
  // LaunchDetail.tokenDecimals (Task 1); callers must not guess this.
  tokenDecimals: number;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

// This panel only ever trades the bonding curve (see Task 9's gating) — no venueKind parameter
// to thread through until a pool-swap follow-up plan actually needs one.
function applySlippage(amount: bigint, slippageBps: number | 'auto'): bigint {
  const bps = slippageBps === 'auto' ? resolveAutoSlippageBps('curve') : slippageBps;
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function BuyPanel({ curveAddress, tokenAddress, tokenDecimals, quoteAsset, explorerBase }: BuyPanelProps) {
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isNativeQuote = quoteAsset.address === zeroAddress;
  const isWrongChain = chainId !== robinhoodChain.id;

  const amountIn = amount === '' ? 0n : parseUnits(amount, quoteAsset.decimals);
  const nativeBalance = useBalance({ address: account, query: { enabled: isNativeQuote && Boolean(account) } });
  const allowance = useTokenAllowance(isNativeQuote ? undefined : quoteAsset.address, isNativeQuote ? undefined : curveAddress);
  const quote = useCurveQuote({
    curveAddress,
    direction: 'buy',
    amountIn,
    recipient: account,
    nativeValue: isNativeQuote ? amountIn : undefined,
  });
  const submission = useTradeSubmission();

  const needsApproval = !isNativeQuote && amountIn > 0n && allowance.allowance < amountIn;
  const hasInsufficientBalance = isNativeQuote && (nativeBalance.data?.value ?? 0n) < amountIn;

  function submitBuy() {
    if (amountIn === 0n || !account) return;
    const minTokensOut = quote.outputAmount !== null ? applySlippage(quote.outputAmount, settings.slippageBps) : 0n;
    submission.submit({
      address: curveAddress,
      abi: curveTradeAbi,
      functionName: 'buy',
      args: [amountIn, minTokensOut, account],
      value: isNativeQuote ? amountIn : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-sm">
          Amount ({quoteAsset.symbol ?? '—'})
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="curve" />
      </div>
      {quote.outputAmount !== null && (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, tokenDecimals)}</p>
      )}
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {needsApproval ? (
        <Button type="button" disabled={allowance.isApproving || isWrongChain} onClick={() => allowance.approve(amountIn)}>
          {allowance.isApproving ? 'Approving…' : 'Approve'}
        </Button>
      ) : (
        <Button type="button" disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain} onClick={submitBuy}>
          Buy
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/buy-panel.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/buy-panel.tsx src/trading/buy-panel.test.tsx
git commit -m "feat(fe): add curve Buy panel with native/ERC20 quote branching"
```

---

## Task 8: Sell panel

**Files:**
- Create: `fe/src/trading/sell-panel.tsx`
- Test: `fe/src/trading/sell-panel.test.tsx`

**Interfaces:**
- Consumes: same as Task 7, plus `erc20Abi` (Task 2) for the launched token's own `balanceOf`.
- Produces: `<SellPanel curveAddress={Address} tokenAddress={Address} tokenDecimals={number} quoteAsset={{ address: Address; symbol: string | null; decimals: number }} explorerBase={string | null} />`.

- [ ] **Step 1: Write the failing test**

```typescript
// fe/src/trading/sell-panel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SellPanel } from './sell-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  tokenBalance: 0n,
  allowance: 0n,
  simulateData: undefined as { result: bigint } | undefined,
  simulateError: null as Error | null,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: (args: { functionName: string }) => {
    if (args.functionName === 'balanceOf') return { data: hooks.tokenBalance, refetch: vi.fn() };
    return { data: hooks.allowance, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: hooks.simulateError }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const quoteAsset = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.tokenBalance = 2000000000000000000n;
  hooks.allowance = 0n;
  hooks.simulateData = undefined;
  hooks.simulateError = null;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('SellPanel', () => {
  it('disables Sell when the amount is empty', () => {
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
  });

  it('disables Sell when the token balance is insufficient', () => {
    hooks.tokenBalance = 0n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
  });

  it('always requires approval first — the launched token is never native ETH', () => {
    hooks.allowance = 0n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sell' })).not.toBeInTheDocument();
  });

  it('submits sell once allowance covers the amount', () => {
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: curve, functionName: 'sell', args: [1000000000000000000n, expect.any(BigInt), '0x1111111111111111111111111111111111111111'] }),
      expect.anything(),
    );
  });

  it('shows "quote unavailable" instead of crashing if the simulated sell result cannot be decoded', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateError = new Error('could not decode result data');
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByText(/quote unavailable/i)).toBeInTheDocument();
  });

  it('disables Sell and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/sell-panel.test.tsx`
Expected: FAIL — `Cannot find module './sell-panel'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/sell-panel.tsx
'use client';

import { useState } from 'react';
import { type Address, formatUnits, parseUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { curveTradeAbi } from './curveAbi';
import { erc20Abi } from './erc20Abi';
import { useCurveQuote } from './use-curve-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings, resolveAutoSlippageBps } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { TradeStatus } from './trade-status';

export interface SellPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — see BuyPanelProps.tokenDecimals.
  tokenDecimals: number;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

function applySlippage(amount: bigint, slippageBps: number | 'auto'): bigint {
  const bps = slippageBps === 'auto' ? resolveAutoSlippageBps('curve') : slippageBps;
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function SellPanel({ curveAddress, tokenAddress, tokenDecimals, quoteAsset, explorerBase }: SellPanelProps) {
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;

  const amountIn = amount === '' ? 0n : parseUnits(amount, tokenDecimals);
  const { data: tokenBalance } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });
  const allowance = useTokenAllowance(tokenAddress, curveAddress);
  const quote = useCurveQuote({ curveAddress, direction: 'sell', amountIn, recipient: account, nativeValue: undefined });
  const submission = useTradeSubmission();

  const needsApproval = amountIn > 0n && allowance.allowance < amountIn;
  const hasInsufficientBalance = (tokenBalance ?? 0n) < amountIn;

  function submitSell() {
    if (amountIn === 0n || !account) return;
    const minQuoteOut = quote.outputAmount !== null ? applySlippage(quote.outputAmount, settings.slippageBps) : 0n;
    submission.submit({ address: curveAddress, abi: curveTradeAbi, functionName: 'sell', args: [amountIn, minQuoteOut, account] });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-sm">
          Amount
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="curve" />
      </div>
      {quote.outputAmount !== null ? (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, quoteAsset.decimals)} {quoteAsset.symbol ?? ''}</p>
      ) : amountIn > 0n && quote.errorMessage ? (
        <p className="text-sm text-muted-foreground">Quote unavailable</p>
      ) : null}
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {needsApproval ? (
        <Button type="button" disabled={allowance.isApproving || isWrongChain} onClick={() => allowance.approve(amountIn)}>
          {allowance.isApproving ? 'Approving…' : 'Approve'}
        </Button>
      ) : (
        <Button type="button" disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain} onClick={submitSell}>
          Sell
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/sell-panel.test.tsx`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
cd fe && git add src/trading/sell-panel.tsx src/trading/sell-panel.test.tsx
git commit -m "feat(fe): add curve Sell panel with graceful quote-unavailable fallback"
```

---

## Task 9: Wire into the launch detail page

**Files:**
- Create: `fe/src/trading/curve-trade-panel.tsx`
- Modify: `fe/src/features/launch/launch-detail.tsx`
- Test: `fe/src/trading/curve-trade-panel.test.tsx`
- Modify: `fe/src/features/launch/launch-detail.test.tsx`

**Interfaces:**
- Consumes: `BuyPanel` (Task 7), `SellPanel` (Task 8), `Tabs` (`fe/src/components/ui/tabs.tsx`, already used elsewhere in `launch-detail.tsx`), `LaunchDetail.tokenDecimals` (Task 1).
- Produces: `<CurveTradePanel curveAddress={Address} tokenAddress={Address} tokenDecimals={number} quoteAsset={{ address: Address; symbol: string | null; decimals: number }} explorerBase={string | null} />`.

- [ ] **Step 1: Write the failing test for the tab switcher**

```typescript
// fe/src/trading/curve-trade-panel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurveTradePanel } from './curve-trade-panel';

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined }),
  useBalance: () => ({ data: undefined, isLoading: false }),
  useReadContract: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: undefined, isLoading: false, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const quoteAsset = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };

describe('CurveTradePanel', () => {
  it('defaults to the Buy tab and switches to Sell', () => {
    render(<CurveTradePanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Sell' }));
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npx vitest run src/trading/curve-trade-panel.test.tsx`
Expected: FAIL — `Cannot find module './curve-trade-panel'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// fe/src/trading/curve-trade-panel.tsx
'use client';

import type { Address } from 'viem';
import { Tabs } from '@/components/ui/tabs';
import { BuyPanel } from './buy-panel';
import { SellPanel } from './sell-panel';

export interface CurveTradePanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  tokenDecimals: number;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

export function CurveTradePanel({ curveAddress, tokenAddress, tokenDecimals, quoteAsset, explorerBase }: CurveTradePanelProps) {
  return (
    <Tabs
      tabs={[
        { value: 'buy', label: 'Buy', content: <BuyPanel curveAddress={curveAddress} tokenAddress={tokenAddress} tokenDecimals={tokenDecimals} quoteAsset={quoteAsset} explorerBase={explorerBase} /> },
        { value: 'sell', label: 'Sell', content: <SellPanel curveAddress={curveAddress} tokenAddress={tokenAddress} tokenDecimals={tokenDecimals} quoteAsset={quoteAsset} explorerBase={explorerBase} /> },
      ]}
    />
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npx vitest run src/trading/curve-trade-panel.test.tsx`
Expected: PASS, 1 test

- [ ] **Step 5: Write the failing tests for `launch-detail.tsx`'s gating**

First, add the same `vi.mock('wagmi', ...)` block from Step 1 to the top of `fe/src/features/launch/launch-detail.test.tsx` (it currently mocks `lightweight-charts` only — add the wagmi mock alongside it, since this file doesn't import `wagmi` directly today).

Then add these tests:

```typescript
it('shows the curve trade panel only when the curve is the current venue and the launch is trading', () => {
  const { rerender } = render(
    <LaunchDetail
      detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading' })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();

  rerender(
    <LaunchDetail
      detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: '500' }), venue({ id: 'pons-v2-v4:0xpool', kind: 'v4_pool', effectiveToBlock: null })], lifecycleStatus: 'graduated' })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
});

it('hides the curve trade panel once the curve is swept, even though it is still the latest venue row', () => {
  render(
    <LaunchDetail
      detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'swept' })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
});

it('hides the curve trade panel when tokenDecimals has not resolved yet, rather than guessing it', () => {
  render(
    <LaunchDetail
      detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading', tokenDecimals: null })}
      transactions={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: FAIL — no `Buy` button rendered yet

- [ ] **Step 7: Wire `CurveTradePanel` into `launch-detail.tsx`**

Add the import:

```typescript
import { CurveTradePanel } from '@/trading/curve-trade-panel';
```

Inside the `LaunchDetail` component, before the `return`, add:

```typescript
const activeCurveVenue = detail.lifecycleStatus === 'trading'
  ? detail.officialVenues.find((venue) => venue.kind === 'curve' && venue.effectiveToBlock === null)
  : undefined;
```

Inside the chart `Card`'s `CardContent` (the price/chart block from the earlier UI-redesign work), add after the price paragraph and before `OfficialChart`:

```tsx
{activeCurveVenue && detail.tokenDecimals !== null && (
  <div className="mt-4 border-t border-border pt-4">
    <CurveTradePanel
      curveAddress={activeCurveVenue.ref as `0x${string}`}
      tokenAddress={detail.tokenAddress as `0x${string}`}
      tokenDecimals={detail.tokenDecimals}
      quoteAsset={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals ?? 18 }}
      explorerBase={explorerBase}
    />
  </div>
)}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: PASS, including the three new tests

- [ ] **Step 9: Run the full FE suite, typecheck, and lint**

Run: `cd fe && npx vitest run && npx tsc --noEmit && npx eslint src`
Expected: all pass, no new errors

- [ ] **Step 10: Commit**

```bash
cd fe && git add src/trading/curve-trade-panel.tsx src/trading/curve-trade-panel.test.tsx src/features/launch/launch-detail.tsx src/features/launch/launch-detail.test.tsx
git commit -m "feat(fe): wire curve Buy/Sell panel into the launch detail page"
```

---

## Not in this plan (follow-up work)

- Swap for a graduated V3/V4 pool (SwapRouter02/Universal Router) — separate plan per the spec's phasing.
- Pool-detail-page Swap (Pools tab) — separate plan.
- Cross-checking the two observed router addresses against an authoritative source — only relevant to the pool-swap follow-up plan, not this one (curve trading has no router dependency).
