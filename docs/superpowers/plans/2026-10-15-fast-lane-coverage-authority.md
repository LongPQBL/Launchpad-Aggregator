# Fast-Lane Coverage Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a healthy WebSocket fast lane provide current official trade coverage to Launches while Envio backfills and repairs missing history, without blanking the last published metrics during temporary gaps.

**Architecture:** Keep Envio as the authority for launch metadata and lifecycle sources. Add a truthful, contiguous fast-lane trade watermark and make a shared per-launch coverage predicate accept either the required Envio trade-source watermark or fast-lane coverage; use that predicate consistently across workers, rankings, lists, details, and candles. Preserve the last published stats and volume when neither source currently covers the safe head, while reporting incomplete coverage.

**Tech Stack:** TypeScript, PostgreSQL, Drizzle, `pg`, Vitest integration tests, Fastify API, existing Envio incremental sync and WebSocket fast lane.

**Spec:** `docs/superpowers/specs/2026-10-15-fast-lane-coverage-authority-design.md`

## Global Constraints

- Chain: Robinhood Chain 4663.
- Fast-lane trade venues: Curve, V3, and V4.
- Use the same safe-head boundary and per-launch required-source mapping in all API and worker paths.
- A WebSocket log by itself does not prove contiguous coverage; only a completed gap-free sweep advances the trusted lane watermark.
- Launch/factory and lifecycle requirements remain Envio-owned.
- Envio backfill remains idempotent on `(chain_id, tx_hash, log_index)`; parity and reorg reconciliation remain enabled.
- Existing unrelated workspace changes must be preserved.

## Review Focus

- Fast lane begins while Envio is behind: coverage must not bridge an unscanned initial interval; test activation with Envio-confirmed baseline and verify the lane only certifies blocks after that baseline.
- Sweep has an RPC error or a gap larger than `FAST_LANE_MAX_GAP_BLOCKS` (default `20_000`): the trusted watermark must not advance; test failure and oversized gap paths.
- A trade source has a per-source Envio gap or an unresolved row: the fast-lane alternative must not accidentally waive factory/lifecycle requirements or claim Envio's unresolved history complete; test source mapping and fallback.
- A new venue is added after the lane's previous sweep: it must not be considered lane-covered for earlier unobserved blocks until Envio confirms them; test delayed watch-set discovery.
- Both sources are behind after a good metric was published: retain the prior value and computed timestamp while marking coverage incomplete; test launch stats and 24-hour USD volume separately.

---

### Task 1: Make fast-lane coverage watermark gap-safe

**Files:**
- Modify: `be/src/db/schema.ts` and add a migration under `be/drizzle/` for `fast_lane_state.coverage_block` and per-venue Envio bridge anchors.
- Modify: `be/src/fastLane/store.ts`
- Modify: `be/src/fastLane/runner.ts`
- Test: `be/src/fastLane/store.integration.test.ts`
- Test: `be/src/fastLane/runner.integration.test.ts`

**Interfaces:**
- Consumes: existing `fast_lane_state(chain_id, last_block, updated_at)` and the existing lane sweep.
- Produces: `last_block` remains the durable resume cursor, `coverage_block` is the highest trusted lane block, and `fast_lane_venue_coverage.envio_bridge_block` records how far Envio must confirm before the lane can cover that venue. Keep `readLaneBlock(db, chainId)` and `advanceLaneBlock(db, chainId, block)` behavior compatible for restart callers, adding narrowly scoped helpers for trusted coverage and anchors.

- [ ] **Step 1: Write failing tests** for (a) initialization from the minimum confirmed Envio trade-source fence, (b) a successful contiguous sweep advancing the lane watermark, (c) an RPC failure preserving the previous watermark, (d) an oversized gap advancing only the resume cursor while preserving the trusted watermark, and (e) a new watched venue falling back to Envio until its earlier interval is covered.
- [ ] **Step 2: Run the focused fast-lane integration tests** and confirm each new assertion fails for the expected reason.
- [ ] **Step 3: Implement the durable anchor and gap-safe advancement.** On first activation, anchor at the conservative Envio-confirmed trade fence; sweep forward from the anchor. Advance the trusted watermark only after every chunk succeeds. When the gap exceeds the configured maximum, advance the resume cursor but leave the trusted watermark unchanged and raise each venue's Envio bridge through the skipped block. Do not treat a venue added after an interval was swept as covered for that earlier interval.
- [ ] **Step 4: Re-run the focused tests** and confirm restart, failed sweep, oversized-gap, and late-watch-set behavior.
- [ ] **Step 5: Commit** the migration, store, runner, and tests as `fix(fast-lane): track contiguous trade coverage`.

### Task 2: Centralize source-aware launch coverage

**Files:**
- Modify: `be/src/coverage/launchCoverageSql.ts`
- Create: `be/src/coverage/launchCoverageSql.integration.test.ts` (or extend the existing coverage integration test file if the project has one).
- Modify: `be/src/api/store.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's durable lane anchor/watermark; existing `launchCoverageSql(headParamIndex: number): string` call sites.
- Produces: the same `launchCoverageSql(headParamIndex)` interface, with one shared SQL predicate that checks factory/lifecycle Envio rows as before and accepts either the matching Envio trade source through safe head or a lane interval proven to cover that source through safe head.

- [ ] **Step 1: Write failing coverage tests** proving Envio trade coverage works, lane coverage can replace only trade-source coverage, factory/lifecycle lag still fails coverage, and a per-source gap or late venue does not get covered by the lane's unrelated interval.
- [ ] **Step 2: Run those tests** and confirm they fail because current SQL only checks Envio `confirmed_to_block`.
- [ ] **Step 3: Update `launchCoverageSql`** to classify required rows as metadata/lifecycle or trade sources and apply the Task 1 watermark only to trade rows whose lane interval is valid for that source/venue. Keep its existing signature so every current call site (launch list/detail, metric ranking, volume calculation/ranking, search, history and candles) uses the same predicate.
- [ ] **Step 4: Re-run coverage and API integration tests** and verify both source alternatives, all negative cases, and consistent coverage in stats, volume, search and candle responses.
- [ ] **Step 5: Commit** the shared predicate and regression tests as `feat(coverage): accept fast-lane trade watermark`.

### Task 3: Keep last good launch stats visible through coverage gaps

**Files:**
- Modify: `be/src/api/store.ts`
- Modify: `be/src/api/launchStatsWorker.ts`
- Modify: `be/src/api/server.ts`
- Modify: `be/src/api/schemas.ts`
- Modify: `fe/src/api/schema.ts` if the API response types are checked in/generated from the OpenAPI schema.
- Test: `be/src/api/store.integration.test.ts`
- Test: `be/src/api/launchStatsStore.integration.test.ts`

**Interfaces:**
- Consumes: Task 2's shared coverage predicate and existing `launch_stats.computed_at`.
- Produces: launch list/detail fields retaining stored trade-derived stats when coverage is incomplete, plus nullable `statsComputedAt` on launch summary/detail responses. `coverageStatus` continues to indicate whether figures are current/complete.

- [ ] **Step 1: Write failing tests** for complete stats refresh from lane-covered trades, fallback to Envio coverage, and stale-stat retention (including `computed_at`) when both sources are behind.
- [ ] **Step 2: Run the focused API tests** and confirm they fail because `statsForCoverage` strips metrics and the worker overwrites old results with NULLs.
- [ ] **Step 3: Update the stats worker and API mapping.** Compute/publish stats when the shared predicate is complete; when incomplete, leave the prior stats row untouched. Return stored stats with `coverageStatus='backfilling'` and its original `computed_at`.
- [ ] **Step 4: Re-run API integration tests** for launch list, detail, metric ranking, and coverage transitions.
- [ ] **Step 5: Commit** the stats behavior and API field as `fix(api): retain launch stats during coverage gaps`.

### Task 4: Preserve and serve the last good 24-hour USD volume

**Files:**
- Modify: `be/src/market/launchVolume/store.ts`
- Modify: `be/src/db/schema.ts` and add a migration under `be/drizzle/` to allow a retained positive/zero score to be marked `updating`.
- Modify: `be/src/market/launchVolume/calculate.ts`
- Modify: `be/src/market/launchVolume/worker.ts`
- Modify: `be/src/market/launchVolume/ranking.ts`
- Modify: `be/src/api/metricRanking.ts`
- Test: `be/src/market/launchVolume/store.integration.test.ts`
- Test: `be/src/market/launchVolume/worker.integration.test.ts`
- Test: `be/src/market/launchVolume/ranking.integration.test.ts`
- Test: `be/src/api/launchStatsStore.integration.test.ts`

**Interfaces:**
- Consumes: Task 2's coverage SQL and existing volume job/claim/publish interfaces.
- Produces: invalidation marks a score `updating` without clearing its last published amount/rank; incomplete recalculation cannot replace a known-good score with NULL; list ranking returns the retained value and `coverageComplete=false` until a source covers the safe head.

- [ ] **Step 1: Write failing tests** for retained positive/zero scores during invalidation, incomplete-volume calculation not erasing a prior score, and a lane-covered score being recomputed from the combined `trades` rows.
- [ ] **Step 2: Run focused launch-volume tests** and confirm the expected failures against current NULL-on-invalidate/publish behavior.
- [ ] **Step 3: Implement preservation and retry behavior.** Keep the last published amount and rank while the job is pending; adjust the score constraint so a positive/zero retained score may have `completeness_reason='updating'`; do not publish an `incomplete_coverage` NULL over a known-good score; allow a later lane or Envio completion to publish a replacement. Ensure job retry timing does not create a hot loop while neither source is current.
- [ ] **Step 4: Re-run launch-volume and API ranking tests** and verify retained values remain sortable and are marked incomplete.
- [ ] **Step 5: Commit** as `fix(volume): retain last complete score during updates`.

### Task 5: Verify live/backfill behavior on the dev database

**Files:**
- No product-code changes unless verification reveals a defect; any defect returns to its owning task above.

**Interfaces:**
- Consumes: Tasks 1–4 and the existing running dev API, workers, Envio DB, and app DB.
- Produces: recorded evidence for lane/Envio watermarks, representative launch API output, and duplicate-free backfill/parity behavior.

- [ ] **Step 1: Run the focused fast-lane, coverage, launch-stats, and launch-volume integration suites, then TypeScript checks.** Record command results; do not claim success without output.
- [ ] **Step 2: Read the app DB's lane anchor/watermark and per-source Envio confirmed blocks** for representative Curve, V3, and V4 launches; verify the shared coverage SQL's expected source is winning.
- [ ] **Step 3: Compare `/v1/launches` and launch detail output** while Envio trails but the lane has swept through safe head; verify metrics are present, `coverageStatus` reflects completeness, and `statsComputedAt` is stable.
- [ ] **Step 4: Confirm stale-value behavior** by checking an incomplete launch retains its most recent stats and USD-volume score without being labeled complete.
- [ ] **Step 5: Observe Envio backfill/parity** for lane-written rows; verify no duplicate trades/notifications and that genuinely missing or reorged rows update derived metrics.
- [ ] **Step 6: Report the observed watermarks, API results, test results, and any remaining gaps.**
