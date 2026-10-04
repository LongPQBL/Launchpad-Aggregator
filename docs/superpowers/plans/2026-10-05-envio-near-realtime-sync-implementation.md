# Envio Near Realtime Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner requested planning only in this session; do not execute this plan yet.

**Goal:** Surface Pons launches and official trades promptly after Envio persists them, while retaining honest coverage and reorg repair.

**Architecture:** Durable per-stream tail/history cursors drive bounded keyset reads from Envio into transactional app writes. Minimal launch rows are published before RPC enrichment. A separate repair pass handles the 500-block provisional window; committed changes notify the existing SSE bridge.

**Tech Stack:** Node.js >=24, TypeScript, PostgreSQL, Drizzle, Fastify, Next.js, viem, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-envio-near-realtime-sync-design.md`

## Global Constraints

- Envio HyperIndex is the sole chain indexer; do not restore RPC scanning or add WebSocket ingestion.
- Additive app migrations; preserve current launches, trades, cursors, and legacy provenance.
- `null` means unavailable; no placeholder numeric values or invented complete coverage.
- Keep exact event identity, block hash, Pons-designated venue rules, and the 500-block reorg window.
- Work on `main` without a worktree or subagents per `CLAUDE.md`; code/API/frontend copy in English.
- Development and disposable databases only during implementation; no trial sync or destructive migration on the existing app DB.

## Review Focus

- A swap arriving before its launch/venue stays unresolved and is retried after that dependency appears (Task 3).
- Empty Envio block ranges advance the cursor without asserting historical completeness (Tasks 1 and 5).
- A crash after reading a page cannot advance its cursor without the app rows, and replay cannot duplicate events (Task 2).
- An Envio rollback behind a tail cursor rewinds and repairs only Envio-derived rows; old-indexer rows survive (Task 4).
- A committed launch/trade notification reaches the UI, while a rolled-back transaction sends none; reconnect recovers missed changes (Task 6).

## File Map and Execution Order

Create focused cursor, page-reader, unresolved-event, repair, and notifier modules in `be/src/envioSync/`; keep the existing full-table functions as offline reconciliation. Extend `be/src/launchpads/pons/metadataEnrichmentStore.ts` for missing core fields; modify `be/src/api/pgEvents.ts`, `fe/src/api/`, and launch components for refresh/pending display. Generate the next additive migration from `be/src/db/schema.ts` into `be/drizzle/`; use the next available number at execution time. This plan precedes the coverage plan. The volume-cache plan can follow once transactional app writes are stable.

**Verification commands:** For each BE integration test file named in a task, run `cd be && npm run test:integration -- src/<named-file>.integration.test.ts`; for BE unit files run `cd be && npm test -- src/<named-file>.test.ts`. For FE files run `cd fe && npm test -- src/<named-file>.test.tsx`. Full gates are `cd be && npm test && npm run test:integration && npm run typecheck && npm run lint`, `cd fe && npm test && npm run typecheck && npm run lint`, and `cd envio && npm test`. A RED step must fail on the stated new behavior, not on setup or connection errors.

### Task 1: Durable stream cursors and bounded Envio pages

**Files:** Create `be/src/envioSync/incrementalCursor.ts`, `be/src/envioSync/incrementalPage.ts`; modify `be/src/db/schema.ts`; generate `be/drizzle/<next>.sql`; test `be/src/envioSync/incrementalPage.integration.test.ts`.

**Interfaces:** `readRawPage(envioPool, { table, chainId, after: { blockNumber, logIndex, id }, fence, limit }): Promise<RawPage>`; `claimSyncCursor(appDb, { stream, chainId, lane }): Promise<SyncCursor>`; `advanceSyncCursor(tx, key, position, processedBlock): Promise<void>`. Streams are V1 launch/swap, V2 launch/curve/buyback/lifecycle, V4 initialize/swap; lanes are `tail` and `history`.

- [ ] Write PostgreSQL tests for strict `(blockNumber, logIndex, id)` order, equal-position IDs, a fixed Envio fence, empty-range advancement, and durable cursor restart.
- [ ] Run `cd be && npm run test:integration -- src/envioSync/incrementalPage.integration.test.ts`; expect RED for missing tables/functions.
- [ ] Add cursor table keyed by `(chain_id, stream, lane)` with block, log index, raw ID, processed watermark, and update time; add/verify supporting Envio raw-table indexes in its managed schema through a supported Envio migration, not ad-hoc live DDL.
- [ ] Implement bounded keyset reads with validated table-name allowlist and parameterized values; cursor must never advance beyond the pass's `latest_processed_block`.
- [ ] Run the targeted integration test, `cd be && npm run typecheck`, and `cd envio && npm test`; expect PASS. Commit the task.

### Task 2: Transactional page application and lane scheduling

**Files:** Create `be/src/envioSync/incrementalSync.ts`; modify `be/src/envioSync/syncAll.ts`, `be/src/cli/syncEnvioStagingLoop.ts`; test `be/src/envioSync/incrementalSync.integration.test.ts`.

**Interfaces:** `applyEnvioPage(envioPool, appDb, { stream, lane, fence, limit }): Promise<{ applied, unresolved, cursor }>`; `runTailPass(...): Promise<SyncReport>` and `runHistoryPass(...): Promise<SyncReport>`. App writes and cursor update share one app-DB transaction.

- [ ] Write integration tests for page failure before commit, replay after restart, overlap between history/tail, duplicate raw events, and downstream dependency ordering.
- [ ] Run the targeted integration test; expect RED.
- [ ] Reuse `transformV1Legacy.ts`, `transformV2.ts`, `transformLifecycle.ts`, and `transformV4.ts`; split their existing real-table persistence into reusable per-page operations. Seed tail at processed head minus 500 blocks and history at each source start; give tail a separate small connection budget and priority.
- [ ] Replace the frequent full-table loop with 1-second interruptible tail passes plus bounded, lower-priority history passes and jittered error backoff. Keep `runAllSyncsOnce` callable offline for reconciliation.
- [ ] Run targeted integration, full BE typecheck, and unit tests; expect PASS. Commit.

### Task 3: Minimal launches, deferred metadata, and unresolved events

**Files:** Modify `be/src/db/schema.ts`, `be/src/domain/types.ts`, `be/src/envioSync/incrementalSync.ts`, `be/src/launchpads/pons/metadataEnrichmentStore.ts`, `be/src/launchpads/pons/metadataEnrichment.ts`, `be/src/api/server.ts`, `be/src/api/schemas.ts`, `be/src/api/store.ts`, `fe/src/features/launch/launch-detail.tsx`, `fe/src/features/launches/launch-list.tsx`; create `be/src/envioSync/unresolvedEvents.ts`; generate migration; update OpenAPI/generated FE types and tests.

**Interfaces:** `enqueueUnresolvedEvent(tx, { stream, chainId, rawId, reason }): Promise<void>` and `retryUnresolvedEvents(...): Promise<number>`; `LaunchSummary` allows missing metadata and displays the token address as name fallback.

- [ ] Add integration/API/UI tests: a raw launch is visible before RPC metadata; missing decimals make dependent metrics `null`; transient RPC failure does not block the next event; swap-before-venue remains retryable; verified enrichment updates the existing row.
- [ ] Run targeted BE integration/API and FE tests; expect RED.
- [ ] Make only unverifiable metadata nullable, preserving existing known rows. Persist minimal event facts first; move core name/symbol/decimals work into bounded retry jobs, reusing extended metadata retry behavior. Never coerce unknown decimals to zero in valuation.
- [ ] Regenerate OpenAPI and FE schema using repository scripts; render address fallback and `—` for missing metrics.
- [ ] Run `cd be && npm run test:integration && npm run typecheck` and `cd fe && npm test && npm run typecheck`; expect PASS. Commit.

### Task 4: Bounded reorg repair

**Files:** Create `be/src/envioSync/incrementalRepair.ts`; modify `be/src/envioSync/reorgGuard.ts`, `be/src/envioSync/incrementalSync.ts`; test `be/src/envioSync/incrementalRepair.integration.test.ts`.

**Interfaces:** `repairEnvioWindow(envioPool, appDb, { chainId, fence, depth: 500n }): Promise<RepairReport>`; report changed launch keys for notifications and future volume-cache invalidation.

- [ ] Test same-block replacement, deletion without replacement, surviving launch metadata, legacy `source_log_id` rows, and Envio processed-block rollback behind the cursor.
- [ ] Run targeted integration; expect RED.
- [ ] Compare canonical event keys plus block hashes only in the provisional window, rewind affected cursors before append, repair in dependency order in one transaction, and retain old-indexer rows.
- [ ] Run targeted integration and typecheck; expect PASS. Commit.

### Task 5: Coverage watermarks and observability

**Files:** Modify `be/src/db/schema.ts`, `be/src/envioSync/incrementalSync.ts`, `be/src/envioSync/syncAll.ts`, `be/src/api/store.ts`, `be/src/api/routes/coverage.ts`; generate migration; test `be/src/envioSync/incrementalSync.integration.test.ts`, `be/src/api/store.integration.test.ts`.

**Interfaces:** `confirmedSourceBlock(streams, lane): bigint | null` returns the minimum contiguous applied block across required streams; expose separate observed Envio head, app-confirmed block, tail lag, and history backlog.

- [ ] Test empty ranges, missing upstream launch, tail ahead of history, and provisional finality; coverage must stay incomplete until all required streams reach the fence.
- [ ] Run targeted integration; expect RED.
- [ ] Persist per-source confirmed watermarks in the app transaction, derive coverage from required stream minimums, and emit counters for tail lag, history backlog, unresolved records, enrichment retries, and repair failures.
- [ ] Run BE integration, typecheck, and lint; expect PASS. Commit.

### Task 6: Commit-bound notifications and UI recovery

**Files:** Create `be/src/envioSync/notifyChanges.ts`; modify `be/src/api/pgEvents.ts`, `be/src/api/events.ts`, `fe/src/api/client.ts`, `fe/src/app/page.tsx`, `fe/src/app/launches/[chainId]/[tokenAddress]/page.tsx`; test BE notification integration and FE refresh tests.

**Interfaces:** `notifyChanged(tx, changes: readonly { kind: 'launch.changed' | 'trade.created' | 'coverage.changed'; chainId: number; tokenAddress?: string }[]): Promise<void>` coalesces per token/type and calls `pg_notify` inside the transaction.

- [ ] Test no notification on rollback, one coalesced notification per token/type on commit, SSE listener reconnect, refetch on reconnect, and low-rate polling recovery after a missed event.
- [ ] Run targeted tests; expect RED.
- [ ] Wire notifier into page application, repair, and enrichment; reconnect LISTEN after disconnect and refresh list/detail UI after relevant SSE events. Keep transactions and latest price ahead of slower derived volume work.
- [ ] Run BE/FE unit and integration suites, typecheck, and lint; expect PASS. Commit.

### Task 7: Disposable rollout and latency gate

**Files:** Create `be/src/cli/benchmarkIncrementalSync.ts`; update `README.md` with local-only startup/rollback commands and measurement interpretation.

- [ ] Add a repeatable disposable-DB probe covering V1/V2/V4 key parity against the offline full pass, raw-visibility-to-app-commit and raw-visibility-to-render timestamps, 429/source lag reporting, and repair/restart cases.
- [ ] Run the probe only against disposable Envio/app databases; expect zero canonical-key mismatches, p95 <= 3 seconds raw visibility to app commit and p95 <= 5 seconds to rendered UI under the spec's healthy local load.
- [ ] Document failures and keep the old full pass as offline reconciliation. Do not switch a live DB or claim chain-to-UI latency from this test. Commit the benchmark and runbook.
