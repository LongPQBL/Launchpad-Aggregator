# V4 Pool Balances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display accurate V4 pool token balances and a value-weighted composition bar on the pool detail page.

**Architecture:** Reuse the backend's existing Reserves Lens `getPoolTVL` read and preserve its per-pool principal token amounts and spot price in the pool summary API. The frontend uses these values for V4 and keeps its existing direct pool-contract reads for V2/V3; invalid or unsupported Lens results remain unavailable.

**Tech Stack:** TypeScript, Fastify, viem, OpenAPI, Next.js, React, wagmi, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-v4-pool-balances-design.md`

## Global Constraints

- Raw token amounts are decimal strings in JSON to preserve integer precision.
- Never use combined PoolManager custody balances, historical swap sums, or estimated values as per-pool reserves.
- A Lens result with custom accounting is not presented as pool principal.
- V2/V3 balance reads and TVL semantics remain unchanged.

## Review Focus

- Large `uint256` reserve values must not lose precision during JSON serialization or frontend formatting; pin raw decimal strings in backend assertions and frontend display tests.
- `displayedToken` can be either currency0 or currency1; assert the API maps the amounts and quote price into displayed/other order for both orientations.
- Lens errors, custom accounting, invalid amounts, and unresolved decimals/price must return `poolBalances: null`, not fabricated values; cover custom accounting and Lens failure in backend tests and null API data in frontend.
- A pool with zero total value must not produce `NaN`/infinite bar widths; add a frontend assertion for finite, bounded bar widths.
- V2/V3 continue using direct contract reads and their existing availability behavior; retain and run their current component tests.

---

### Task 1: Return pool-specific V4 balances from the stats calculation

**Files:**
- Modify: `be/src/pools/stats.ts`
- Test: `be/src/pools/stats.integration.test.ts`

**Interfaces:**
- Produces `PoolBalanceSnapshot = { displayedAmountRaw: string; otherAmountRaw: string; priceInQuote: string } | null` as `PoolStats.poolBalances`.
- For V4, the amounts and `priceInQuote` come from one valid Reserves Lens snapshot. For V2/V3, `poolBalances` is `null`.

- [ ] **Step 1: Add failing integration assertions for a valid Lens snapshot**

Assert `readPoolStats(..., a, ...)` returns exact decimal strings for `coreAmount0` and `coreAmount1` in displayed/other order and a lens-derived spot `priceInQuote`; assert the reverse orientation swaps the amounts and reciprocates the price as appropriate. Include amounts larger than JavaScript's safe integer range.

- [ ] **Step 2: Run the focused integration test and confirm the new assertions fail**

Run: `cd be && npm run test:integration -- src/pools/stats.integration.test.ts`
Expected: existing setup passes and the new `poolBalances` assertions fail because the property is not returned.

- [ ] **Step 3: Refactor the lens calculation to retain snapshot data**

In `be/src/pools/stats.ts`, define `PoolBalanceSnapshot` and add `poolBalances` to `PoolStats`. Replace the TVL-only lens helper with one snapshot helper returning `{ poolBalances, tvlUsd }`. Read the Lens once; accept only nonnegative bigint core amounts, positive `sqrtPriceX96`, `hasCustomAccounting === false`, resolved decimals, and a non-null price from `poolPriceInQuote`. Serialize raw amounts with `.toString()`. Keep the existing `calculateTvlUsd` inputs and null behavior for `tvlUsd`; do not make balance availability depend on quote USD pricing.

- [ ] **Step 4: Add failing assertions for unavailable Lens results**

Assert `poolBalances` is null when `getPoolTVL` throws and when the result has `hasCustomAccounting: true`; preserve the existing TVL expectations.

- [ ] **Step 5: Run the focused integration test and confirm it passes**

Run: `cd be && npm run test:integration -- src/pools/stats.integration.test.ts`
Expected: PASS, including exact raw strings, both token orientations, and unavailable Lens states.

- [ ] **Step 6: Commit the backend snapshot change**

```bash
git add be/src/pools/stats.ts be/src/pools/stats.integration.test.ts
git commit -m "feat: expose v4 pool balance snapshots"
```

### Task 2: Add the nullable balance snapshot to the pool API contract

**Files:**
- Modify: `be/src/api/poolStore.ts`, `be/src/api/schemas.ts`, `be/openapi.json`, `fe/src/api/schema.ts`
- Test: `be/src/api/pools.integration.test.ts`

**Interfaces:**
- Consumes Task 1's `PoolStats.poolBalances`.
- Produces `PoolSummary.poolBalances`, nullable and shaped as `{ displayedAmountRaw: string; otherAmountRaw: string; priceInQuote: string }`.

- [ ] **Step 1: Add a failing pool API assertion**

In `be/src/api/pools.integration.test.ts`, assert the V4 detail response contains `poolBalances` with the raw amount strings and spot price returned by the stats reader. Also assert a null snapshot is serialized explicitly as `null`.

- [ ] **Step 2: Run the focused API integration test and confirm it fails**

Run: `cd be && npm run test:integration -- src/api/pools.integration.test.ts`
Expected: the test fails because `poolBalances` is not yet part of the summary/schema.

- [ ] **Step 3: Thread the field through the API summary and schema**

In `be/src/api/poolStore.ts`, ensure `PoolSummary` inherits `poolBalances` from `PoolStats`. In `be/src/api/schemas.ts`, define the nullable object with all three string fields and add it to `poolSummary`.

- [ ] **Step 4: Regenerate API contracts**

Run: `cd be && npm run openapi:write`
Run: `cd fe && npm run generate:schema`
Expected: `be/openapi.json` and `fe/src/api/schema.ts` both include nullable `poolBalances` with string properties.

- [ ] **Step 5: Run API and schema checks**

Run: `cd be && npm run test:integration -- src/api/pools.integration.test.ts && npm run openapi:check`
Run: `cd fe && npm run check:schema`
Expected: API integration and both schema checks pass.

- [ ] **Step 6: Commit the API contract change**

```bash
git add be/src/api/poolStore.ts be/src/api/schemas.ts be/openapi.json be/src/api/pools.integration.test.ts fe/src/api/schema.ts
git commit -m "feat: add pool balance snapshot to API"
```

### Task 3: Render V4 token balances and value composition

**Files:**
- Modify: `fe/src/features/pools/pool-detail.tsx`, `fe/src/features/pools/pool-stats.tsx`, `fe/src/features/pools/pool-balances.tsx`
- Test: `fe/src/features/pools/pool-balances.test.tsx`

**Interfaces:**
- Consumes API `PoolSummary.poolBalances` from Task 2.
- `PoolBalances` receives `poolBalances: PoolSummary['poolBalances']`; V4 uses the snapshot, while V2/V3 continue using `useBalance`/`useReadContract`.

- [ ] **Step 1: Add failing V4 rendering tests**

Test a V4 snapshot with known decimals and price: assert both formatted quantities appear and the composition bar widths represent displayed value (`displayed amount × priceInQuote`) versus other amount. Test a null snapshot shows an unavailable message. Test zero total values produce finite widths between 0% and 100%. Keep existing V2/V3 assertions.

- [ ] **Step 2: Run the focused frontend test and confirm new assertions fail**

Run: `cd fe && npm test -- src/features/pools/pool-balances.test.tsx`
Expected: V4 snapshot props are not accepted/rendered and the old unavailable message is shown.

- [ ] **Step 3: Pass the API snapshot into `PoolBalances`**

Thread `pool.poolBalances` from `pool-detail.tsx` through `PoolStats` to `PoolBalances`. Update `PoolBalances` to use the API snapshot for V4 and preserve existing direct reads for V2/V3. Format raw amounts with `formatUnits` before compact formatting. For V4, calculate a bounded value-weighted bar from the snapshot's price. Replace the permanent “not available for V4 pools yet” text with an unavailable state only when `poolBalances` is null.

- [ ] **Step 4: Run focused frontend tests and typecheck**

Run: `cd fe && npm test -- src/features/pools/pool-balances.test.tsx src/features/pools/pool-stats.test.tsx && npm run typecheck`
Expected: PASS, with V4 data and bar rendered and existing V2/V3 tests unchanged.

- [ ] **Step 5: Commit the frontend rendering change**

```bash
git add fe/src/features/pools/pool-detail.tsx fe/src/features/pools/pool-stats.tsx fe/src/features/pools/pool-balances.tsx fe/src/features/pools/pool-balances.test.tsx
git commit -m "feat: render v4 pool balances"
```
