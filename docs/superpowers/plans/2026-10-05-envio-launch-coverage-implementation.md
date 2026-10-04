# Envio Launch Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Implementation checkpoint (2026-10-05):** Tasks 1–4 and the Task 5 CLI/runbook are implemented in commits `643a7bf` through `6038afa`. The full three-factory baseline remains unmeasured because the configured Envio PostgreSQL endpoint refused connections. See `docs/operations/2026-10-05-launch-parity-baseline.md`; do not claim launch completeness yet.

**Goal:** Prove that every finalized launch event from each configured Pons factory exists in Envio and is promoted into the app, with visible incompleteness when parity fails.

**Architecture:** A versioned source registry drives a bounded three-way comparison of independent chain logs, Envio raw launches, and app launches at a fixed finalized fence. Persist per-range reports and distinguish missing Envio ingestion from missing app promotion. The near-realtime sync plan supplies minimal launch promotion and per-stream app watermarks.

**Tech Stack:** TypeScript, viem, PostgreSQL/Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-envio-data-coverage-pools-retention-design.md` §§ Coverage and reconciliation.

## Global Constraints

- Cover the two known V1 factories and the V2 factory with exact factory address, launch topic, chain ID 4663, and configured start block.
- Compare canonical `(chainId, factoryAddress, txHash, logIndex)` keys and block hashes, not token counts alone.
- Audit a fixed finalized fence; latest 500 blocks remain provisional. Source coverage and app-sync progress are distinct.
- Do not declare complete because Envio reports head or `source_gaps` is empty. Unknown factories and mismatches make coverage visibly incomplete.
- Use bounded RPC/HyperSync reads with retry/rate limits; no whole-chain unbounded scan. Work on `main` without subagents.

## Review Focus

- Exact start-block events for all three factories are included; an event before the source start is outside the claim (Task 2).
- Duplicate raw rows or app rows do not inflate parity counts and are reported as defects (Task 3).
- A raw Envio launch absent from app indicates promotion failure, even while metadata remains pending (Task 3).
- Same event key with changed block hash is a reorg discrepancy, not an equal record (Task 3).
- Adding a factory address without Envio config/audit coverage marks the source unsupported, not complete (Task 1).

## File Map and Dependencies

Modify `be/src/launchpads/pons/sourceRegistry.ts` and validate it against `envio/config.yaml`. Create `be/src/coverage/launchParity.ts`, `parityStore.ts`, and a bounded CLI in `be/src/cli/`; extend coverage API only after reports are persisted. Generate the next additive migration from `be/src/db/schema.ts` at execution time. Run after the near-realtime plan's minimal launch promotion and app-confirmed watermarks; this plan does not implement that sync path. The volume and Pools plans may consume coverage state but do not block parity auditing.

**Verification commands:** Run unit files with `cd be && npm test -- src/<named-file>.test.ts`, integration files with `cd be && npm run test:integration -- src/<named-file>.integration.test.ts`, and the full gate with `cd be && npm test && npm run test:integration && npm run typecheck && npm run lint`. A RED step must fail on the specified parity behavior, not on provider credentials or database setup.

### Task 1: Versioned source registry and config consistency

**Files:** Modify `be/src/launchpads/pons/sourceRegistry.ts`; create `be/src/coverage/sourceRegistryCheck.ts` and test; inspect `envio/config.yaml`, `envio/src/EventHandlers.ts`.

**Interfaces:** `validateLaunchSourceConfig(sources, envioConfig): SourceConfigIssue[]`; each `FactorySource` includes enabled status, registry version, event signature/topic, and start block.

- [ ] Test both V1 and V2 topics, all three addresses/start blocks, duplicate address, omitted Envio handler/config, and an unknown newly listed factory.
- [ ] Run `cd be && npm test -- src/coverage/sourceRegistryCheck.test.ts`; expect RED.
- [ ] Add registry metadata and a parser/consistency check; keep V2's earlier Envio start as an explicit safe over-scan, not a parity mismatch. Fail the coverage claim if config or handler support is absent.
- [ ] Run targeted test and `cd be && npm run typecheck`; expect PASS. Commit.

### Task 2: Bounded independent launch-log evidence

**Files:** Create `be/src/coverage/readLaunchEvidence.ts`, `be/src/coverage/readLaunchEvidence.test.ts`; add CLI flags in `be/src/cli/auditLaunchParity.ts`.

**Interfaces:** `readLaunchEvidence(client, source: FactorySource, fromBlock: bigint, toBlock: bigint, maxRange: bigint): Promise<LaunchEventKey[]>`. Reject ranges below start or above the fixed finalized fence; partition into bounded requests.

- [ ] Test inclusive start/fence boundaries, provider 429/backoff, duplicate responses, wrong topic/address exclusion, and deterministic sorting; fixture covers all three known factories.
- [ ] Run targeted test; expect RED.
- [ ] Use exact address/topic `eth_getLogs` or bounded HyperSync; preserve block hash. Allow a second provider/sample check and label which provider supplied each report.
- [ ] Run targeted test and typecheck; expect PASS. Commit.

### Task 3: Three-way parity and durable reports

**Files:** Create `be/src/coverage/launchParity.ts`, `parityStore.ts`, `launchParity.integration.test.ts`; modify `be/src/db/schema.ts`; generate migration.

**Interfaces:** `compareLaunchRange({ source, fromBlock, toBlock, fence, chainEvents, envioRows, appRows, envioWatermark, appWatermark }): ParityReport`; `saveParityReport(tx, report): Promise<void>`.

- [ ] Test zero parity, chain-only missing raw row, raw-only missing app row, extra raw/app row, duplicate keys, changed block hash, pending metadata counted as promoted, and provisional range exclusion.
- [ ] Run `cd be && npm run test:integration -- src/coverage/launchParity.integration.test.ts`; expect RED.
- [ ] Read Envio `RawLaunch`/`RawLaunchV2` and app launch provenance by exact event key; add any missing additive app provenance columns without deleting `source_log_id`. Store range counts, first/last block, missing/extra keys, watermarks, provider, registry version, and report status.
- [ ] Run targeted integration and typecheck; expect PASS. Commit.

### Task 4: Coverage API, repair queue, and runbook

**Files:** Modify `be/src/api/store.ts`, `be/src/api/routes/coverage.ts`, `be/src/api/schemas.ts`; create `be/src/coverage/repairRanges.ts`; test API/integration; update `README.md`.

**Interfaces:** `enqueueParityRepair(sourceId, fromBlock, toBlock, failureLayer): Promise<void>` schedules only the affected bounded range; `getCoverage()` reports latest finalized parity fence and separate Envio/app watermarks.

- [ ] Test source marked incomplete after mismatch, unknown registry source, stalled cursor, affected-range replay request, resolved parity, and provisional tail kept separate.
- [ ] Run targeted API/integration tests; expect RED.
- [ ] Expose honest status and alert counters; schedule bounded Envio reindex or app promotion repair according to the failing layer. Never auto-claim repaired coverage before the next parity report passes.
- [ ] Run BE integration, typecheck, and lint; expect PASS. Commit.

### Task 5: Baseline finalized audit

**Files:** Update `README.md` with safe audit command and report location; use the CLI from Task 2.

- [ ] On a disposable or explicitly read-only environment, pin a finalized block and run bounded reports for all three factories; record source ranges and provider limits.
- [ ] Require zero missing/extra event keys per configured factory before claiming completeness. If Envio's DB or provider is unavailable, record the audit as not run; do not substitute local launch count.
- [ ] Preserve the report and repeat procedure for initial backfill, new factory, reindex, and periodic checks. Commit documentation only.
