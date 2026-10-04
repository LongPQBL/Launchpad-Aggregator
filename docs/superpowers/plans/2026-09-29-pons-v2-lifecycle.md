# Pons V2 Lifecycle and Official V4 Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index Pons V2 lifecycle transitions and official Robinhood V4 pool swaps so token history, chart, volume and coverage remain correct through graduation and reorg.

**Architecture:** Factory lifecycle logs are immutable evidence; current factory phase is an independently checked observation. The indexer persists transitions and verified V4 venues with raw-log provenance, scans each official pool from its Initialize block, and derives API/market projections from those records. Reorg deletes invalid evidence and rebuilds affected projections.

**Tech Stack:** Node.js >=24, TypeScript, viem, PostgreSQL, Drizzle, Fastify, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-pons-v2-lifecycle-design.md` and its parent `docs/superpowers/specs/2026-09-28-pons-readonly-design.md`.

## Global Constraints

- Work directly on `main`; do not create a worktree. Do not push or deploy without a separate instruction.
- Historical task scope is Pons V2 lifecycle on Robinhood Chain ID `4663`, its curve and Pons-created V4 pool. The former product-wide ban on “Pools khác” was revoked by the owner on 2026-10-04; other pools belong to a separate Envio-based Pools work unit.
- Documents/user-facing copy are Vietnamese; code names, comments, tests and API fields are English.
- No real trading, wallet connection, Redis, Kafka or new chain in this plan.
- Use raw integer quantities/rational prices; do not use floating-point arithmetic for money.
- A fixture or partial public-RPC backfill does not prove full historical coverage.

## Review Focus

- Factory launch is indexed after its token has already graduated: initial launch must remain historical phase 0, while current status reflects verified transitions (Tasks 1, 3, 5).
- Curve trade, sweep, Initialize and V4 swap can share a block: order by `logIndex` and retain valid trades on either side (Tasks 2, 3, 4).
- A newly discovered pool whose creation block precedes the shared chain head must scan from its own Initialize block (Task 4).
- Wrong PoolManager, hook, pool ID, chain or transaction must never establish an official venue (Task 3).
- Reorg that removes only the graduation block must restore the older curve launch and discard V4 venue/trades/candles without stale status (Tasks 2, 5).

---

## File map

- `be/src/launchpads/pons/v2/lifecycle.ts`: pure lifecycle event decoding, transition validation and pool-Initialize matching.
- `be/src/domain/types.ts`, `be/src/db/schema.ts`, `be/src/db/repository.ts`: transition types/storage, exact event positions, atomic batch save and reorg-safe projection.
- `be/src/indexer/lifecycleRuntime.ts`: lifecycle source definition and decoding using launch contexts plus receipt logs.
- `be/src/indexer/v4Runtime.ts`: official pool-ID-specific Swap sources and decoder; reusable scan/checkpoint engine remains in `scan.ts`.
- `be/src/indexer/venueStore.ts`, `be/src/cli/runFactoryIndexer.ts`: context reads and bounded source ordering.
- `be/src/api/store.ts`, `be/src/api/server.ts`, `be/src/api/schemas.ts`: projected lifecycle/coverage/market responses; routes remain read-only.
- `be/src/market/aggregate.ts`, `be/src/market/price.ts`: existing official-only aggregation and candle price path; no pool-discovery module.
- Tests alongside modules and `be/src/db/repository.integration.test.ts`; generated migration in `be/drizzle/`.

### Task 1: Historical launch status and lifecycle event decoder

**Files:** Modify `be/src/launchpads/pons/v2/adapter.ts`, `be/src/launchpads/pons/v2/adapter.test.ts`, `be/src/launchpads/pons/v2/abi.ts`; create `be/src/launchpads/pons/v2/lifecycle.ts`, `be/src/launchpads/pons/v2/lifecycle.test.ts`.

**Interfaces:** `decodeV2LifecycleLog(log: RpcLog, factory: FactorySource): V2LifecycleEvent | null`, where `V2LifecycleEvent = { tokenAddress: Address; phase: 1 | 2 | 3; kind: 'swept' | 'graduated' | 'rescued'; sourceLogId: string; blockNumber: bigint; blockHash: Hash; txHash: Hash; logIndex: number }`. `hydrateV2Launch(...)` always emits historical `lifecycleStatus: 'trading'`.

- [ ] **Step 1: Write failing tests.** Assert a record currently at phase 2 still hydrates launch as `trading`; decode sweep/graduate/rescue fixtures into phases 1/2/3; ignore `LaunchForceSwept` as a separate transition; reject wrong factory and malformed log.
- [ ] **Step 2: Run red.** `npm test -w be -- v2/adapter.test.ts v2/lifecycle.test.ts`; expect the new assertions to fail.
- [ ] **Step 3: Implement the interfaces.** Use exact event signatures in official Pons V2 factory source and existing `logKey`; keep decoder pure.
- [ ] **Step 4: Run green.** Same command and `npm run typecheck -w be`; expect exit 0.
- [ ] **Step 5: Commit.** `git add` only the five listed files; commit `feat: decode pons v2 lifecycle evidence`.

### Task 2: Atomic transition storage and reorg-safe projection

**Files:** Modify `be/src/domain/types.ts`, `be/src/db/schema.ts`, `be/src/db/repository.ts`, `be/src/db/repository.integration.test.ts`; generate migration with `npm run db:generate -w be`.

**Interfaces:** Add `LifecycleTransition` to `IndexBatch.transitions` (empty array required from each existing decoder). Add nullable `v4PoolFee`/`v4TickSpacing` to `Launch` and persisted launch rows; V2 hydration copies the factory record values, V1 leaves them null. Add `transitionPosition = { blockNumber: bigint; logIndex: number }` in persisted transition records. `saveIndexBatch(...)` inserts transitions, optional V4 venue, raw logs and cursor atomically. `retractBlocks(...)` removes them via provenance and recomputes `launches.lifecycleStatus`/venue boundaries from surviving transitions. Preserve a v1 launch unchanged.

- [ ] **Step 1: Write failing integration tests.** Insert launch+curve with V2 pool fee/tick spacing, sweep and graduation in separate batches; assert status/venue boundary; replay gives one transition; failed foreign key does not move cursor; reorg graduation restores `swept`, removes V4/trades; reorg sweep restores `trading`; same-block log indexes preserve trade placement.
- [ ] **Step 2: Run red.** `npm run test:integration -w be -- repository.integration.test.ts`; expect failures from missing schema/repository behavior.
- [ ] **Step 3: Implement migration/repository.** Reference each transition to raw log; use delete cascade and deterministic projection in the same transaction; never mutate the historical launch origin status based on current head phase. Update all existing batch producers/tests to pass `transitions: []`.
- [ ] **Step 4: Run green.** `npm run db:migrate -w be` against the test DB, integration tests, `npm run typecheck -w be`; expect exit 0.
- [ ] **Step 5: Commit.** Stage domain/DB files, affected batch producers/tests and generated migration; commit `feat: persist reorg-safe pons lifecycle`.

### Task 3: Verified graduation and lifecycle scanner

**Files:** Create `be/src/indexer/lifecycleRuntime.ts`, `be/src/indexer/lifecycleRuntime.test.ts`; modify `be/src/launchpads/pons/v2/poolKey.ts`, `be/src/launchpads/pons/v2/v4Swaps.test.ts`, `be/src/indexer/venueStore.ts`, `be/src/cli/runFactoryIndexer.ts`.

**Interfaces:** `getV2LifecycleSource(): LogSource` with ID `pons-v2-lifecycle`, factory address and start block `26841846n`; `createLifecycleDecoder(loadLaunch, getReceiptLogs): ScanDeps['decodeLogs']`; `verifyPonsV4PoolInitialization(...)` remains the strict pool-key/receipt check. `loadLaunch(token)` returns persisted V2 launch+curve venue+pool fee/tick spacing. At runtime read factory immutables `poolManager()` and `memeHook()` once, validate addresses against source audit and pass them to decoder. Lifecycle scan head cannot exceed V2 launch-source cursor.

- [ ] **Step 1: Write failing tests.** Sweep→graduate receipt with matching Initialize creates one transition and official V4 venue; a wrong tx/pool/hook/manager fails without cursor advance; force-sweep is not duplicated; unknown launch does not get skipped; Initialize before PoolGraduated in the same receipt sets exact start `logIndex`.
- [ ] **Step 2: Run red.** `npm test -w be -- lifecycleRuntime.test.ts v4Swaps.test.ts`; expect failures.
- [ ] **Step 3: Implement decoder/runtime wiring.** Fetch one transaction receipt per graduation and match its Initialize; reuse verified pool-ID derivation, scan factory lifecycle after factory launch source, and persist via Task 2 transaction. Failed validation creates a visible gap/degraded source.
- [ ] **Step 4: Run green.** Targeted tests, integration tests and typecheck; expect exit 0.
- [ ] **Step 5: Commit.** Stage only lifecycle runtime and touched files; commit `feat: verify pons v2 graduation on chain`.

### Task 4: Official V4 Swap backfill and live catch-up

**Files:** Create `be/src/indexer/v4Runtime.ts`, `be/src/indexer/v4Runtime.test.ts`; modify `be/src/launchpads/pons/v2/v4Swaps.ts`, `be/src/launchpads/pons/v2/v4Swaps.test.ts`, `be/src/cli/runFactoryIndexer.ts`, `be/src/indexer/venueStore.ts`.

**Interfaces:** `getV4PoolSources(venues: readonly VenueContext[]): LogSource[]` creates durable per-pool source IDs with startBlock equal to Initialize block; `createV4TradeDecoder(context, getTimestamp): ScanDeps['decodeLogs']` accepts only `PoolManager.Swap` with indexed ID matching official venue. Pool source is registered before scanning, and `scanToHead` resumes from its own checkpoint.

- [ ] **Step 1: Write failing tests.** Backfill pool discovered after head advanced; filter same PoolManager but another pool ID; accept verified protocol hook swap with volume once; reject swap before Initialize position; restart/replay is idempotent and receipt/source errors preserve cursor.
- [ ] **Step 2: Run red.** `npm test -w be -- v4Runtime.test.ts v4Swaps.test.ts`; expect failures.
- [ ] **Step 3: Implement per-pool scan.** Query Swap by PoolManager address + indexed pool ID; bound blocks per cycle and reuse adaptive retry/gap reporting. Avoid scanning all PoolManager swaps or pool discovery.
- [ ] **Step 4: Run green.** Targeted tests, integration tests and typecheck; expect exit 0.
- [ ] **Step 5: Commit.** Stage V4 runtime/touched files; commit `feat: backfill official pons v4 swaps`.

### Task 5: Phase reconciliation, official market API and candles

**Files:** Modify `be/src/api/store.ts`, `be/src/api/server.ts`, `be/src/api/schemas.ts`, `be/src/api/server.test.ts`, `be/src/market/aggregate.test.ts`, `be/src/db/repository.ts`, `be/src/cli/runFactoryIndexer.ts`; add focused tests for phase reconciliation.

**Interfaces:** `reconcileV2Phase(token, safeBlock, readPhase)` compares persisted transition projection with factory phase at `safeBlock`, returning `verified | incomplete | mismatch`; API coverage requires lifecycle source and every discovered official V4 source, not a non-existent hardcoded umbrella source. `officialVolume24h` is nullable until all relevant sources cover the window. Candle projection uses existing `buildOfficialCandles`; no candle for a bucket without priced trade.

- [ ] **Step 1: Write failing tests.** Phase mismatch/old-state RPC failure marks incomplete; list/detail/trades/candles show only official venue data; curve→V4 candles preserve chronological order and no gap candle; official 24h volume includes actual curve buyback and hook swap exactly once; incomplete curve price does not produce a fabricated candle; reorg recomputes status/volume/candles.
- [ ] **Step 2: Run red.** `npm test -w be -- api/server.test.ts aggregate.test.ts` plus relevant integration tests; expect failures.
- [ ] **Step 3: Implement projection/coverage.** Read authoritative phase at a safe block where provider supports it; store observation provenance or report provider limitation. Aggregate only verified official trade rows. Rebuild affected candles after committed trade/lifecycle range and after reorg. Keep `null` instead of 0 for incomplete metric.
- [ ] **Step 4: Run green.** Targeted tests, integration tests, typecheck, `npm run openapi:write -w be` then `npm run openapi:check -w be`; expect exit 0.
- [ ] **Step 5: Commit.** Stage API/market/repository/CLI and OpenAPI if changed; commit `feat: expose verified pons v2 lifecycle metrics`.

### Task 6: Live fixture audit, documentation and full verification

**Files:** Modify `README.md`, `docs/superpowers/specs/2026-09-29-pons-v2-lifecycle-design.md` only if a verified finding changes the design; add verified fixture/test under `be/tests/fixtures/` and corresponding test file.

**Interfaces:** Read-only RPC audit of the existing graduated V2 sample records launch, sweep, graduation, Initialize and Swap `(block, tx, logIndex)` references. Report exact source cursors, gaps and which prices/metrics remain incomplete on the public RPC; do not equate sample verification with complete chain history.

- [ ] **Step 1: Add fixture assertions.** Verify real sample transaction/log provenance and sample V4 trade amount/price against raw log; test fixture locally without live RPC dependency.
- [ ] **Step 2: Run targeted tests.** Expect PASS after Task 4/5 implementation; fix only bugs exposed by fixture, preserving TDD.
- [ ] **Step 3: Perform bounded live audit.** Query only explicit sample blocks/transactions and a bounded indexer cycle; record measured counts/cursors/gaps and provider limitations in README. Do not silently run a full historical backfill.
- [ ] **Step 4: Verify full suite.** `npm run lint -w be`, `npm run typecheck -w be`, `npm test -w be`, `npm run test:integration -w be`, `npm run build -w be`, `npm run openapi:check -w be`, `git diff --check` all exit 0; check `git status --short` and mark any remaining historical gap as incomplete.
- [ ] **Step 5: Commit.** Stage fixture/docs and bounded fixes; commit `docs: record pons v2 lifecycle verification`.

## Exit gate

This plan completes the **backend implementation**, not the entire product: FE remains a later step. A public-RPC historical gap or unverified curve historical price must be reported honestly and must keep affected chart/metric coverage incomplete. Do not claim all Robinhood launches or chart history are complete until independent reconciliation and archive-state checks pass.
