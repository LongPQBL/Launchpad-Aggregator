# Envio Volume24h USD Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Planning only in this session; do not execute yet.

**Goal:** Rank all Pons launches by official 24-hour USD volume with a fast indexed read and a correct, eventually fresh derived score.

**Architecture:** Transactional invalidations feed a durable per-launch queue. A bounded worker recomputes affected launches from canonical official trades and historical oracle rounds, then publishes versioned scores. The API switches to indexed keyset reads only after a complete backfill and reconciliation gate.

**Tech Stack:** Node.js >=24, TypeScript, PostgreSQL/Drizzle, Fastify, Vitest, Next.js.

**Spec:** `docs/superpowers/specs/2026-10-04-envio-volume24h-usd-cache-design.md`

## Global Constraints

- Preserve `valueTradeUsd` semantics: verified round at or before each trade position, 24-hour age limit, one unpriceable positive trade makes the launch volume `null`.
- Official Pons venue trades only; include executed buybacks/internal swaps once. A complete empty window is exactly `0`, incomplete coverage is `null`.
- Keep migrations additive; leave old pricing tables/jobs and old read-side calculation for offline parity, never as an unbounded production fallback.
- Natural pagination reads the latest rank and may duplicate/skip a moving launch between pages; document this behavior.
- The 60-second p95 target starts after the trade and its price are in the app DB; Envio source delay is measured separately.
- Work on `main` without a worktree or subagents per `CLAUDE.md`; no production deployment in this plan.

## Review Focus

- A reorg that deletes the only recent trade must lower the cached score without a replacement event (Task 2).
- A late or corrected oracle round must reprice every affected launch, including `null` to known and known to `null` (Task 3).
- A trade leaving the inclusive 24-hour window at `timestamp + 86401` must trigger a recompute with no new trade (Task 4).
- A stale worker must not overwrite a newer invalidation; a crashed claim must retry (Task 1).
- Backfill gaps, worker outage, and unavailable scores must never appear as zero or a silently old ranking (Tasks 5 and 6).

## File Map and Dependencies

Create `be/src/market/launchVolume/` for schema-adjacent queue/store, invalidation, calculation, worker, and reconciliation code. Modify Envio real-table transaction writers in `be/src/envioSync/` and oracle writers in `be/src/market/quotePricing/`; modify `be/src/api/store.ts`, cursor, schemas, OpenAPI, and FE list rendering. Generate the next additive migration in `be/drizzle/` at execution time. Prefer the near-realtime plan's page-application and reorg change-key interfaces when that plan lands; if it has not landed, integrate with existing `runSync.ts`, `runSyncV2.ts`, `runSyncV4.ts` transactions directly. Volume-cache invalidation must not depend on in-memory notifications.

**Verification commands:** For each BE integration test named in a task, run `cd be && npm run test:integration -- src/<named-file>.integration.test.ts`; for BE unit tests run `cd be && npm test -- src/<named-file>.test.ts`; for FE tests run `cd fe && npm test -- src/<named-file>.test.tsx`. Full gates are `cd be && npm test && npm run test:integration && npm run typecheck && npm run lint` and `cd fe && npm test && npm run typecheck && npm run lint`. Regenerate contracts with `cd be && npm run openapi:write` and `cd fe && npm run generate:schema`; verify with `cd be && npm run openapi:check` and `cd fe && npm run check:schema`. RED means the intended behavior fails, not DB setup.

### Task 1: Durable score and work tables

**Files:** Modify `be/src/db/schema.ts`; create `be/src/market/launchVolume/store.ts`, `be/src/market/launchVolume/store.integration.test.ts`; generate `be/drizzle/<next>.sql`.

**Interfaces:** `invalidateLaunchVolume(tx, keys: readonly LaunchKey[], dueAt: Date): Promise<void>`; `claimVolumeJobs(pool, now: Date, limit: number): Promise<VolumeClaim[]>`; `publishVolumeScore(pool, claim, score: VolumeScore): Promise<boolean>`. `LaunchKey = { chainId: number; tokenAddress: string }`. Score includes nullable decimal USD, rank category, `computedAt`, `windowEnd`, `nextExpiryAt`, completeness reason, revision, and launch-position tie breakers.

- [ ] Write PostgreSQL tests for deduplication, revision increment, earlier due time, concurrent claims, expired lease retry, and rejection of a stale publish.
- [ ] Run `cd be && npm run test:integration -- src/market/launchVolume/store.integration.test.ts`; expect RED.
- [ ] Add `launch_volume24h_usd` and deduplicated work tables with FK/indexes for positive-descending, zero, null, launch position, due jobs, and lease expiry. Publish only when the claim's revision remains current.
- [ ] Run targeted integration and `cd be && npm run typecheck`; expect PASS. Commit.

### Task 2: Transactional Envio invalidation and reorg keys

**Files:** Create `be/src/market/launchVolume/invalidate.ts`; modify `be/src/envioSync/runSync.ts`, `runSyncV2.ts`, `runSyncV4.ts`, `reorgGuard.ts` or their incremental successors; test `be/src/envioSync/reorgGuard.integration.test.ts` and `be/src/market/launchVolume/invalidate.integration.test.ts`.

**Interfaces:** `collectAffectedLaunchKeys(tx, deletedAndInsertedEventKeys): Promise<LaunchKey[]>`; call Task 1's `invalidateLaunchVolume` in the same app transaction as canonical trade/venue/lifecycle writes. Stage-only sync does not enqueue jobs.

- [ ] Test new trade, venue transition, launch replacement, reorg deletion with no replacement, and one job for multiple swaps of one token.
- [ ] Run targeted integration; expect RED.
- [ ] Capture keys from rows before reorg deletion and from inserted rows; enqueue once per transaction. Mark the previously published row updating/`null` before commit so API cannot serve a known stale score.
- [ ] Run targeted integration and typecheck; expect PASS. Commit.

### Task 3: Oracle and coverage invalidation

**Files:** Modify `be/src/market/quotePricing/priceRounds.ts`, `feedRegistry.ts`, `be/src/api/store.ts` or source-progress writer; create `be/src/market/launchVolume/oracleInvalidation.ts`; test `be/src/market/launchVolume/oracleInvalidation.integration.test.ts`.

**Interfaces:** `invalidateForPriceChange(tx, { chainId, quoteAssetAddress, feedAddress, fromBlock, toBlock }): Promise<number>`; `invalidateForCoverageChange(tx, affectedSourceIds): Promise<number>`.

- [ ] Test inserted/corrected round, verified-feed remap/revocation, incomplete-to-complete coverage, and complete-to-incomplete coverage; unrelated quote assets must remain untouched.
- [ ] Run targeted integration; expect RED.
- [ ] Make price upsert and affected-launch invalidation one DB transaction; use set-based official-trade queries over the affected 24-hour/price interval. Invalidate rows when source progress/gaps change completeness, in bounded batches for broad source changes.
- [ ] Run targeted integration and typecheck; expect PASS. Commit.

### Task 4: Exact per-launch recomputation and expiry

**Files:** Create `be/src/market/launchVolume/calculate.ts`, `worker.ts`, `calculate.integration.test.ts`, `worker.integration.test.ts`; create `be/src/cli/runLaunchVolumeWorker.ts`.

**Interfaces:** `calculateLaunchVolume(pool, key: LaunchKey, windowEnd: number): Promise<VolumeScore>`; `refreshDueLaunchVolumes(pool, now: Date, limit: number): Promise<WorkerReport>`.

- [ ] Test historical round position and staleness, fixed-point sum parity with `valueTradeUsd`, official venue transition, buyback counted once, unrelated pool excluded, positive unpriced trade, incomplete coverage, true zero, and `timestamp + 86401` expiry.
- [ ] Run targeted integration; expect RED.
- [ ] Recompute only one launch at one `windowEnd`; share valuation logic or demonstrate exact parity with trade-page values. Schedule `nextExpiryAt` and periodic sweep, bound worker connections/concurrency, and publish only through Task 1 revision check.
- [ ] Run targeted integration, typecheck, and lint; expect PASS. Commit.

### Task 5: Indexed API ranking, cursor, and UI freshness

**Files:** Modify `be/src/api/store.ts`, `volumeCursor.ts`, `server.ts`, `schemas.ts`, `server.test.ts`, `store.integration.test.ts`, `be/openapi.json`, `fe/src/api/schema.ts`, `fe/src/features/launches/launch-list.tsx` and its tests.

**Interfaces:** `listLaunches({ sort: 'volume24hUsd' })` reads cache-ranked keys in SQL and enriches only the selected page; add `officialVolume24hUsdAsOf: string | null` to `LaunchSummary`. Cursor v2 holds last rank key and issue time.

- [ ] Test global rank across filters, positive/zero/null tails, launch-position ties, first/later pages, moved rank between pages, malformed/old/tampered cursor, and no 24-hour-trade scan on the volume API path.
- [ ] Run BE API/integration and FE list tests; expect RED.
- [ ] Implement SQL keyset order and signed cursor v2; preserve `sort=recent`. Show freshness/unknown state and handle prompt 503 with `Retry-After` when initial backfill is incomplete or heartbeat exceeds two minutes.
- [ ] Regenerate OpenAPI/FE types; run targeted suites, typecheck, lint; expect PASS. Commit.

### Task 6: Backfill, reconciliation, and switch gate

**Files:** Create `be/src/cli/backfillLaunchVolumes.ts`, `be/src/cli/reconcileLaunchVolumes.ts`; add worker/backfill state in `be/src/market/launchVolume/store.ts`; test `be/src/market/launchVolume/backfill.integration.test.ts`.

- [ ] Test resumable bounded backfill, new launch during backfill, zero/null tails, failed batch retry, worker heartbeat loss, and comparison against old read-side values.
- [ ] Run targeted integration; expect RED.
- [ ] Backfill active/new launches first, then every remaining launch; retain the old read-side code only for integration/offline reconciliation. Gate API switch on full filtered-set rankability and parity, with no silent omission.
- [ ] Run targeted integration, typecheck, and lint; expect PASS. Commit.

### Task 7: Scale and contention benchmark

**Files:** Modify `be/src/cli/benchmarkVolumeRanking.ts`, `generateSyntheticTrades.ts`; create `be/src/cli/benchmarkLaunchVolumeWorker.ts`; update README runbook.

- [ ] Benchmark at least 5.5M trades/180K in the last 24h, a separate 160K+ launch scenario, one concentrated high-volume launch, cold/warm and first/later pages, filters, concurrent reads, and worker plus Envio/price jobs.
- [ ] Record warm list p95 < 3 seconds, cold < 8 seconds, commit-with-price-to-published-rank p95 <= 60 seconds, worst backlog, and <= 10% p95 regression for Envio new-launch/trade commits and transaction/price reads under equal load.
- [ ] If gates fail, profile and retain the old computation only for comparison; do not claim completion or switch production ranking. Document measurements and commit benchmark/runbook.
