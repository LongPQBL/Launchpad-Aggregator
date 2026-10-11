# Token page Volume / TVL over all pools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Token-page Volume and TVL charts cover every verified pool holding the token (official venue included), as in the spec.

**Architecture:** Per-pool rollups already exist for volume (`pool_volume_buckets`); extend TVL snapshots/buckets to V3/V2 and sum per bucket at read time in `readLaunchHistory`. The curve-scoped call (`venue=curve`) is unchanged.

**Tech Stack:** TypeScript, Fastify, pg, viem, Vitest (unit + PostgreSQL integration), Next.js, Lightweight Charts.

**Spec:** `docs/superpowers/specs/2026-10-11-token-all-pools-volume-tvl-design.md`

## Global Constraints

- null means unavailable, never a silent zero. A swap is counted once (official pools are excluded from the "other pools" volume sum).
- Migrations are additive. Stage explicit files only (the tree has user WIP in `fe/`).
- Frontend copy is English. Work on `main`.

## Review Focus

- Token with no pool besides its curve: TVL buckets are all null, volume still works.
- A pool with no verified USD feed on either side: counted in `unvaluedPools`, `complete: false`, volume buckets are not guessed.
- A pool created after a bucket must not null that bucket.
- A token whose official V4 pool is also in `pool_volume_buckets` must not double count.

### Task 1: Allow V3/V2 in TVL tables
**Files:** Modify `be/src/db/schema.ts` (the two protocol CHECKs), generated migration under `be/drizzle/`.
- [ ] Change both checks to `IN ('uniswap_v4','uniswap_v3','uniswap_v2')`; run `npm run -w be db:generate`; apply with `npm run -w be db:migrate` (dev) and the test DB.
- [ ] Commit schema + migration.

### Task 2: Capture V3/V2 TVL snapshots
**Files:** Create `be/src/pools/poolAmounts.ts` (+ `poolAmounts.test.ts`); modify `be/src/pools/tvlCapture.ts`, `be/src/pools/tvlSnapshots.ts` (widen `protocol`).
**Interfaces:** Produces `readPoolAmounts(client, row): Promise<{ blockNumber: bigint; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint } | null>` for `row = { protocol, poolId, currency0, currency1, fee, tickSpacing, hooks }`.
- [ ] Test: V2 `getReserves` (r0=2e18, r1=8e18) gives sqrt price `isqrt(r1<<192 / r0)`; zero reserves gives null; V3 reads `slot0` + two `balanceOf`.
- [ ] Implement; V4 keeps `readLensSnapshot`. `captureTvlSnapshots` selects all verified pools of the chain (any protocol), uses `readPoolAmounts`, same valuation (`calculateTvlUsd`, basis `pool_custody` for V3/V2).
- [ ] Run `npm run -w be test`; commit.

### Task 3: All-pools history read
**Files:** Modify `be/src/pools/history.ts` (export `pickPricedSide`), `be/src/market/launchHistory.ts`, `be/src/api/store.ts` (pass `rpcClient`), `be/src/api/schemas.ts` (`poolCount`, `unvaluedPools`), `be/src/api/server.ts` type; Test `be/src/market/launchHistory.integration.test.ts`.
**Interfaces:** `readLaunchHistory(pool, { ..., rpcClient?: UsdPriceClient })` returns `PoolHistoryResult & { poolCount?: number; unvaluedPools?: number }`. `venueKind` set keeps curve-only behavior.
- [ ] Failing integration tests: (a) official + other V3 pool volume sums, official V4 pool not double counted; (b) unpriced pool → `unvaluedPools = 1`, `complete=false`; (c) TVL sums two pools per bucket, a pool whose first snapshot/trade is later does not null earlier buckets, an existing pool without a snapshot nulls the bucket.
- [ ] Implement: discover pools via `pool_members` ⨝ `pool_catalog`; other-pool volume from `pool_volume_buckets` using `pickPricedSide`; TVL from `pool_tvl_buckets` (steps 3600/14400/86400) or `pool_tvl_snapshots`; pool "since" = earliest of first snapshot and first `pool_trades` timestamp.
- [ ] Regenerate `be/openapi.json` (`openapi:write`) and `fe/src/api/schema.ts` (`generate:schema`); run unit + integration; commit.

### Task 4: Frontend labels and note
**Files:** Modify `fe/src/features/pools/pool-chart-panel.tsx` (`labels` prop), `fe/src/features/launch/launch-chart-panel.tsx`, `fe/src/features/pools/pool-history-chart.tsx` (note), `fe/src/api/client.ts` (`PoolHistory` optional fields); update tests.
- [ ] Launch panel without `venue` labels tabs "Volume · all pools" / "TVL · all pools"; with `venue="curve"` unchanged. Note "Excludes N pools without a USD price" when `unvaluedPools > 0`.
- [ ] `npx tsc --noEmit`, eslint, vitest; commit.

### Task 5: Verify in the real UI
- [ ] Run the V3/V2 snapshot worker once on the dev DB (`POOL_TVL_SNAPSHOT_INTERVAL_SECONDS=60`), start the API (`npm run -w be dev:api`) and a Next dev server on a free port against it, open a token with several pools in Chrome, check Volume and TVL tabs for every range (histogram/area drawn, labels, null gaps), compare totals against the pool pages, and fix what is wrong. Report what was and was not verified.
