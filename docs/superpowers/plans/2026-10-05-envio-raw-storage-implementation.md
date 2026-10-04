# Envio Raw Storage Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Planning only in this session; do not execute yet.

**Goal:** Measure and control Envio's own raw-event database growth without breaking HyperIndex replay, reorg handling, launch parity, or the app's archive-backed old pages.

**Architecture:** Audit actual Envio schema usage and bytes first. Benchmark two supported candidates on disposable copies: minimal per-event entities with an Envio-compatible lifecycle, and a lean live-window projection plus durable aggregates backed by the app archive. Select a candidate only after restart, reindex, reorg, parity, and restore tests prove it safe.

**Tech Stack:** Envio HyperIndex, PostgreSQL, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-envio-data-coverage-pools-retention-design.md` § Envio raw DB growth.

## Global Constraints

- Never manually delete Envio-managed rows from a live HyperIndex schema; verify supported behavior first.
- Envio and app PostgreSQL are separate storage budgets. App trade archive does not shrink Envio `RawSwap`/`RawV4Swap`.
- Keep exact launch, Initialize, Swap, lifecycle event identity and enough inputs for app replay and reorg repair.
- Schema removal can change Envio entity fingerprints and force reindex; require backup, rebuild, parity audit, and rollback evidence.
- Placeholder `sender`, `recipient`, `liquidity`, and `tick` fields may be removed only after consumer and future pool-math audit.
- No live Envio schema change or pruning in this planning session.

## Review Focus

- A full reindex from the configured source start still yields zero missing/extra finalized Pons launches (Task 3).
- New V4 Pools sync can reconstruct token sides, pool identity, and pool trades after proposed raw-column removal (Task 1).
- Restart/reorg replay cannot resurrect pruned rows incorrectly or lose the only copy of old swaps (Tasks 2–3).
- App archive old-page restore remains available with exact historical price evidence if Envio retains only a live window (Task 3).
- Candidate measurements distinguish Envio raw DB savings from app DB savings (Task 2).

## File Map and Dependencies

Audit `envio/schema.graphql`, `envio/src/EventHandlers.ts`, `be/src/envioSync/` hydrators, and new pool sync consumers. Create read-only measurement and disposable-candidate scripts under `envio/scripts/` and a report under `docs/operations/`. Do not alter the production Envio schema until the Pools and app archive plans define their full raw-field and historical-data requirements. The chosen candidate may require its own follow-on migration plan after measurements; record exact commands and gates rather than assuming HyperIndex supports pruning.

### Task 1: Field-level consumer and byte audit

**Files:** Create `envio/scripts/auditRawStorage.ts`, `docs/operations/envio-raw-storage-audit.md`; inspect `envio/schema.graphql`, `envio/src/EventHandlers.ts`, `be/src/envioSync/transform*.ts`, pool-sync modules.

- [ ] Produce a matrix mapping every raw field to Pons launch/trade, lifecycle, V4 pool identity/swap math, replay, archive, and reorg consumers. Mark placeholder writes separately from verified event facts.
- [ ] Run read-only PostgreSQL size queries for raw tables/indexes and project growth per million swaps; compare against app DB independently.
- [ ] Check that a proposed removal of sender/recipient/liquidity/tick leaves no current or planned consumer without input; otherwise keep the field. Commit audit/report only.

### Task 2: Disposable candidate benchmarks

**Files:** Create `envio/scripts/benchmarkStorageCandidates.ts`, disposable fixtures/tests under `envio/test/`, and benchmark report.

- [ ] Build two disposable candidates: (A) minimal per-event raw entities plus a documented, supported lifecycle; (B) lean live-window entities/aggregates with the verified app archive as history. If Envio has no supported pruning mechanism, record candidate A as retain-only until one is proven.
- [ ] Test read/write throughput, storage bytes, replay from source start, app-sync lag, and historical rebuild behavior at representative V4 swap volume. Run `cd envio && npm test`; expect PASS.
- [ ] Record candidate cost/savings and operational steps, including reindex time and rollback. Commit scripts/report.

### Task 3: Reindex, restart, reorg, parity, and restore proof

**Files:** Add `envio/test/storageLifecycle.integration.test.ts`; extend coverage and archive disposable harnesses.

- [ ] For each candidate, test full historical backfill, process restart, latest-500-block reorg replacement/deletion, V1/V2/V4 app sync, finalized launch parity, and archive old-page restore.
- [ ] Run on disposable Envio/app databases and a test object store; require zero missing/extra finalized launch keys and exact old-page event/price parity.
- [ ] Reject any candidate that needs unsupported manual HyperIndex deletion or fails replay/reorg/restore. Document the selected candidate and required follow-on migration; do not switch live storage here.
