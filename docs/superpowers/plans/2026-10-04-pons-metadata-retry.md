# Pons Metadata Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist new launches through optional RPC failures and eventually fill missing Pons metadata and launch timestamps, including historical rows.

**Architecture:** Four per-function read states and retry/lease fields live on `launches`. A typed reader distinguishes terminal contract failures from retryable RPC failures. A DB-backed minute budget lets one bounded worker claim due rows across all processes, read only pending functions, and update the same launch identity; the Envio real-table sync loop and one-shot command drive it.

**Tech Stack:** Node.js >=24, TypeScript, viem, PostgreSQL, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-pons-metadata-retry-design.md`

## Global Constraints

- Work directly on `main`, with no worktree or subagents (per `CLAUDE.md`).
- Optional metadata failures must never block launch/trade indexing or advance/roll back scan cursors.
- `null` remains the public value for unavailable metadata; no fabricated values.
- Default enrichment capacity is 10 launches per minute, one RPC worker, half of each batch reserved for oldest due rows; unused slots can cross-fill.
- Retry transient/unknown errors with exponential delay from one minute to one hour; a typed contract revert or zero-data result is terminal for that function.
- Sanitize logged errors; never log RPC URLs or credentials.
- Use additive migrations, preserve existing launch data, and run integration tests only against a database ending in `_test`.

## Review Focus

- Viem wraps a 429/timeout inside `ContractFunctionExecutionError`: the inner transport error remains retryable (Task 2).
- A successful empty `socials()` tuple marks the function done and does not trigger infinite retries (Task 2).
- An old row with one social URL present is already done for `socials()` (Task 1).
- Envio deletes and reinserts a launch during a reorg while an RPC read is in flight: the old lease result cannot overwrite the new row (Task 3).
- Jobs mode and Envio sync run simultaneously: only one process claims a launch at a time (Task 3).

---

## File map

- `be/src/db/schema.ts`, `be/drizzle/0020_*.sql`, `be/drizzle/meta/*`: durable metadata state, global minute budget, due/lease index, and additive backfill.
- `be/src/launchpads/pons/extendedMetadata.ts`: typed per-function read result and error classification, including block timestamp.
- `be/src/launchpads/pons/metadataEnrichmentStore.ts`: bounded, fair DB claim and fenced update.
- `be/src/launchpads/pons/metadataEnrichment.ts`: one-pass RPC worker and retry timing.
- `be/src/envioSync/runSync.ts`, `runSyncV2.ts`: persist immediate read states alongside new Envio launches.
- `be/src/cli/syncEnvioStagingLoop.ts`, `syncEnvioStaging.ts`: run enrichment with Envio real-table sync without coupling failures to indexing.

### Task 1: Persist metadata read state

**Files:** Modify `be/src/db/schema.ts`; create generated `be/drizzle/0020_*.sql` and metadata snapshot; test `be/src/db/metadataState.integration.test.ts`.

**Interfaces:** `launches` gains `logoReadState`, `descriptionReadState`, `socialsReadState`, `timestampReadState` (`'pending' | 'done'`, default `'pending'`), `metadataRetryAt` (nullable timestamptz), `metadataRetryCount` (integer, default 0), `metadataLeaseId` (nullable text), and `metadataLeaseUntil` (nullable timestamptz). A partial due index covers Pons rows with any pending state. A singleton `metadata_enrichment_budget` row records `last_started_at` so all processes share the same 10-per-minute allowance.

- [ ] **Step 1: Write a failing DB test.** Assert a newly inserted launch defaults all four states to `pending`; assert the migration SQL seeds old non-null logo/description/timestamp as `done` and `socials` as `done` when either URL exists, while null fields stay `pending`. Assert the singleton budget row exists. Use an isolated test schema for the migration assertion.
- [ ] **Step 2: Run it and confirm failure.** `cd be && npm run test:integration -- src/db/metadataState.integration.test.ts`.
- [ ] **Step 3: Add schema columns and generate the migration.** Run `cd be && npm run db:generate`; edit the generated SQL to backfill existing rows without issuing RPC calls, add valid-state checks and the partial due index.
- [ ] **Step 4: Verify.** Run the targeted integration test and `cd be && npm run typecheck`; both pass.
- [ ] **Step 5: Commit.** `git add be/src/db/schema.ts be/drizzle be/src/db/metadataState.integration.test.ts && git commit -m "feat: persist Pons metadata retry state"`.

### Task 2: Classify optional reads

**Files:** Modify `be/src/launchpads/pons/extendedMetadata.ts` and its unit test.

**Interfaces:** Export `ReadOutcome<T> = { state: 'done'; value: T | null } | { state: 'pending'; value: null; errorKind: 'transport' | 'unknown' }`, `BlockReadClient = { getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }> }`, and `MetadataReadResults` (independent `logo`, `description`, `socials`, and `timestamp` outcomes). Add `readExtendedTokenMetadataOutcomes(client, token)` for the first three and `readLaunchTimestamp(client, blockNumber)` for the fourth. `socials.value` contains `{ websiteUrl, twitterUrl }`. Keep the existing `readExtendedTokenMetadata` wrapper until Task 4 changes callers. Export a pure mapper from outcomes to the existing `ExtendedTokenMetadata` plus read-state fields.

- [ ] **Step 1: Write failing unit tests.** Assert empty string and empty socials are `done`/null; wrapped viem revert and zero-data are `done`/null; wrapped 429, timeout, and generic unknown errors are `pending`; one failing function does not erase the others; block-read timeout is `pending`.
- [ ] **Step 2: Run and confirm failure.** `cd be && npx vitest run src/launchpads/pons/extendedMetadata.test.ts`.
- [ ] **Step 3: Implement the reader and classifier.** Walk typed viem causes; check transport causes before terminal contract causes. Preserve `socials()` tuple order and avoid message-only permanent classifications.
- [ ] **Step 4: Verify.** Run the targeted test and `cd be && npm run typecheck`; both pass.
- [ ] **Step 5: Commit.** `git add be/src/launchpads/pons/extendedMetadata* && git commit -m "feat: classify optional Pons metadata reads"`.

### Task 3: Claim and finish due launches safely

**Files:** Create `be/src/launchpads/pons/metadataEnrichmentStore.ts` and `.integration.test.ts`.

**Interfaces:** Export `claimDueMetadataLaunches(db: Database, now: Date, limit: number, leaseMs: number): Promise<ClaimedMetadataLaunch[]>` and `finishMetadataLaunch(db: Database, claim: ClaimedMetadataLaunch, result: MetadataReadResults, now: Date): Promise<boolean>`. A claim includes chain/token, launch block/transaction/log index, pending states, and a unique lease ID. `finish` only updates an extant row with matching identity and lease ID; it clears the lease and sets fields/states/retry timing atomically. Export `nextMetadataRetryAt(now: Date, retryCount: number): Date` (delay `min(60 * 2^retryCount, 3600)` seconds).

- [ ] **Step 1: Write failing integration tests.** Assert a 10-row claim chooses five newest and five oldest due rows; two concurrent claims have no duplicate; a second claim inside the same minute gets no budget; an unexpired lease cannot be reclaimed, an expired one can; deleting/reinserting a launch rejects the stale finish; a successful empty social result stops retrying. Assert retry delays of one minute, two minutes, and the one-hour cap.
- [ ] **Step 2: Run and confirm failure.** `cd be && npm run test:integration -- src/launchpads/pons/metadataEnrichmentStore.integration.test.ts`.
- [ ] **Step 3: Implement claim and finish.** Lock the singleton budget row in a short transaction; if at least 60 seconds elapsed, record the new run time and claim at most 10 rows with `FOR UPDATE SKIP LOCKED` and unique lease IDs. No RPC call occurs while a DB lock is held. Cap lease duration and use identity/lease predicates on update.
- [ ] **Step 4: Verify.** Targeted integration test and `cd be && npm run typecheck` pass.
- [ ] **Step 5: Commit.** `git add be/src/launchpads/pons/metadataEnrichmentStore* && git commit -m "feat: claim and update metadata retries safely"`.

### Task 4: Persist immediate Envio read outcomes

**Files:** Modify `be/src/envioSync/runSync.ts`, `runSyncV2.ts`, their integration tests, and the reader files from Task 2 as required.

**Interfaces:** Both real-table syncs map Task 2 outcomes to `logoUri`, `description`, `websiteUrl`, `twitterUrl`, `launchTimestamp`, and the four state columns on insert. Existing rows retain their stored metadata/read state. The staging path stays unchanged. Remove the old plain-value reader once these callers use `readExtendedTokenMetadataOutcomes`.

- [ ] **Step 1: Add failing integration cases for V1 and V2.** A transient optional RPC error inserts a launch with the affected state `pending` and does not block required metadata/trades; typed revert and successful empty value insert `done`; timestamp timeout is `pending`.
- [ ] **Step 2: Run and confirm failure.** `cd be && npm run test:integration -- src/envioSync/runSync.integration.test.ts src/envioSync/runSyncV2.integration.test.ts`.
- [ ] **Step 3: Change the two prefetch/insert paths.** Reuse the Task 2 mapper, keep reads before reorg reconciliation, and never throw for optional read failure.
- [ ] **Step 4: Verify.** Targeted integration tests, Task 2 unit test, and `cd be && npm run typecheck` pass.
- [ ] **Step 5: Commit.** `git add be/src/envioSync/runSync.ts be/src/envioSync/runSyncV2.ts be/src/envioSync/*.integration.test.ts be/src/launchpads/pons/extendedMetadata* && git commit -m "feat: retain retry state for Envio metadata reads"`.

### Task 5: Run bounded enrichment with Envio sync

**Files:** Create `be/src/launchpads/pons/metadataEnrichment.ts` and `.test.ts`; modify `be/src/cli/syncEnvioStagingLoop.ts`, `syncEnvioStaging.ts`.

**Interfaces:** Export `enrichMetadataOnce(db: Database, client: ExtendedMetadataReadClient & BlockReadClient, now: Date, limit = 10): Promise<{ claimed: number; completed: number; pending: number }>`; call Task 3 claim/finish and Task 2 reader. Export `enrichMetadataSafely(db: Database, client: ExtendedMetadataReadClient & BlockReadClient, now: Date, log: (event: { kind: string; claimed?: number; completed?: number; pending?: number }) => void): Promise<void>` as the shared logging/error boundary used by both CLIs. In the Envio real-table loop, schedule it once per minute independently of the sync cycle; the one-shot real-table CLI runs one pass after sync. Staging-only mode skips enrichment. The DB minute budget prevents duplicate work across processes. Local catches report sanitized counts/categories and do not fail Envio sync.

- [ ] **Step 1: Write failing worker tests.** Assert only pending functions are called, a recovered field updates while another times out, old rows beyond the 500-block window are processed, and `enrichMetadataSafely` catches an error and logs only its sanitized category.
- [ ] **Step 2: Run and confirm failure.** `cd be && npx vitest run src/launchpads/pons/metadataEnrichment.test.ts`.
- [ ] **Step 3: Implement worker and wire the two Envio CLIs.** Keep one worker and the default 10/minute budget; do not change Envio or app DB sync cursors. In loop mode, stop the worker on the existing SIGINT/SIGTERM signal and await its in-flight pass before closing the DB pools.
- [ ] **Step 4: Verify.** Run targeted tests, `cd be && npm run typecheck && npm run lint && npm run build`, then `cd be && npm test` and `cd be && npm run test:integration`; all pass.
- [ ] **Step 5: Commit.** Stage only Task 5 files and commit `feat: retry missing Pons metadata in bounded batches`.

## Completion check

Confirm migration applies to a copy of the test DB with pre-existing launches, metadata repairs after a retry, old rows are eventually eligible, and no optional failure aborts Envio sync. Report any provider throughput limit rather than claiming all historical metadata is already filled.
