# Parallel Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show new Pons launches quickly while historical factory, lifecycle, and trade data backfill in parallel without omissions or double counting.

**Architecture:** A PostgreSQL job queue stores disjoint certified block windows plus overlapping provisional near-head windows. Factory coverage gates lifecycle/trade coverage; persisted on-chain event identity deduplicates replays. A bounded scheduler allocates RPC capacity to near-head and historical work independently.

**Tech Stack:** Node 24, TypeScript, viem, PostgreSQL, Drizzle, Fastify, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-parallel-indexer-design.md`

## Global Constraints

- Preserve Pons V1/V2 on Robinhood, official venues only, current provenance/source IDs, and no trading feature.
- RPC URLs and keys remain environment-only and redacted from logs, jobs, and API errors.
- Keep every `eth_getLogs` request at or below 2,000 inclusive blocks by default; make RPC concurrency configurable per endpoint.
- Certified coverage requires all upstream pools/launches through the window end; provisional work never makes a metric complete.
- Keep the existing indexer running until the new runner passes tests and a controlled restart is ready; never run two writers against the same unleased source.
- Preserve the existing dirty worktree; stage/commit only files belonging to each task.

## Review Focus

- A pool created at the final block of a window must be included in that window's trade query and decoded using `logIndex` bounds (Task 1).
- A late worker result after lease expiry or reorg must not publish stale data or coverage (Tasks 2 and 6).
- A near-head scan with unknown older pools must not publish complete volume, even if it found zero trades (Tasks 3 and 5).
- A worker crash after writing logs but before marking completion must replay without duplicate trade/volume (Task 2).
- A newly discovered V4 pool whose Initialize predates discovery must backfill from Initialize rather than discovery time (Task 4).
- An ETA based on one short or rate-limited sample must be marked unreliable, not shown as a precise completion time (Task 7).

---

### Task 1: Block-eligible venue selection and baseline metrics

**Files:** Create `be/src/indexer/eligibleVenues.ts`, `be/src/indexer/eligibleVenues.test.ts`; modify `be/src/cli/runFactoryIndexer.ts`, `be/src/indexer/tradeRuntime.test.ts`, `be/src/cli/benchmarkParallelTrades.ts` only where the existing flow needs the selection/metric.

**Interfaces:** Produce `eligibleVenues(contexts: readonly VenueContext[], fromBlock: bigint, toBlock: bigint): VenueContext[]`; `eligibleAddresses(...)` may derive the unique addresses from this result. Consume `VenueContext.venue.effectiveFromBlock/effectiveToBlock`. The trade RPC callback computes eligibility per request window rather than once for the whole source; the decoder retains all contexts it may encounter.

- [ ] **Step 1 — Test red:** `eligibleVenues.test.ts` asserts a pool born at `toBlock` is included, one born at `toBlock+1` is excluded, one ended before `fromBlock` is excluded, and a pool ending at `fromBlock` remains for `logIndex` validation. Add a trade-source test proving the RPC group contains only eligible addresses while a log from a newly born pool decodes.
- [ ] **Step 2 — Verify red:** `npm test -w be -- eligibleVenues.test.ts tradeRuntime.test.ts`; expect the new behavior test to fail.
- [ ] **Step 3 — Implement:** Add the pure selector; pass it to grouped trade-log fetches without changing trade provenance or source ID. Record per-query `eligibleAddressCount`, block span and duration in safe structured benchmark output. Replace the benchmark's raw RPC error logging with `safeErrorMessage`; never print RPC URL.
- [ ] **Step 4 — Verify and benchmark:** Run targeted tests, typecheck, and a bounded benchmark against the same historical 2,000-block window before/after; record request count, wall time and errors in README. Commit only Task 1 files.

### Task 2: Durable block-window jobs, leases, and atomic commits

**Files:** Modify `be/src/db/schema.ts`, `be/src/db/repository.ts`, `be/src/db/repository.integration.test.ts`; generate a new `be/drizzle/0010_*.sql` and metadata with `npm run db:generate -w be`; create `be/src/indexer/jobTypes.ts`.

**Interfaces:** `ScanLane = 'certified' | 'provisional'`; `ScanJob = { id: string; sourceId: string; lane: ScanLane; fromBlock: bigint; toBlock: bigint; generation: bigint; leaseOwner: string | null; leaseUntil: Date | null; status: 'pending' | 'leased' | 'complete' | 'failed' }`. Repository adds `enqueueScanJob(job)`, `claimScanJob(workerId, now, leaseMs)`, `commitScanJob(jobId, workerId, generation, batch)`, `failScanJob(jobId, workerId, generation, reason)`, and `getCertifiedFrontier(sourceId)`; keep `saveIndexBatch` for the old runner until cutover.

- [ ] **Step 1 — Test red:** Two workers claim distinct jobs with `SKIP LOCKED`; expired lease can be reclaimed; old owner/generation commit is rejected; a deliberately failed transaction leaves both batch and job incomplete; replaying a completed provisional window as certified keeps one log/trade and advances the certified frontier only when all preceding certified windows exist.
- [ ] **Step 2 — Verify red:** `npm run test:integration -w be -- repository.integration.test.ts`; expect the new assertions to fail.
- [ ] **Step 3 — Implement:** Add job table with unique `(source_id,lane,from_block,to_block)`, lease/generation fields and certified-window overlap protection. Extract the existing batch persistence into a transaction helper used by old and new commit paths. Seed one certified interval from each existing contiguous cursor in a migration/backfill routine; preserve source gaps and never infer coverage across them.
- [ ] **Step 4 — Verify:** Run integration suite twice against PostgreSQL, then typecheck/build. Commit migration, repository and tests as one independently reversible change.

### Task 3: Dependency frontier and cost-aware planner

**Files:** Create `be/src/indexer/jobPlanner.ts`, `be/src/indexer/jobPlanner.test.ts`; modify `be/src/indexer/venueStore.ts` only to expose required official venue positions efficiently.

**Interfaces:** `planCertifiedJobs(source: SourceDefinition, fromBlock: bigint, safeHead: bigint, upstreamFrontiers: ReadonlyMap<string,bigint>, estimatePoolCount: (from: bigint,to: bigint) => Promise<number>): Promise<ScanWindow[]>`; `ScanWindow = { fromBlock: bigint; toBlock: bigint }`; job windows have no overlap and do not exceed 2,000 inclusive blocks. Expose `dependencyFrontier(sourceId, frontiers)` for V1 trade, V2 lifecycle/curve, and V4 pool sources.

- [ ] **Step 1 — Test red:** Factory windows may be planned independently/out of order; trade cannot be certified past its factory frontier; lifecycle waits for V2 launch frontier; V4 starts at Initialize and waits for relevant lifecycle/venue evidence; later windows with more pools are smaller; an empty/unknown upstream frontier does not become complete.
- [ ] **Step 2 — Verify red:** `npm test -w be -- jobPlanner.test.ts`; expect failures.
- [ ] **Step 3 — Implement:** Make dependency and window sizing pure except pool-count lookup. Use measured work estimate (eligible pool count × blocks) with a configurable target and hard 2,000-block cap; do not assume a fixed worker owns a fixed historical half.
- [ ] **Step 4 — Verify:** Targeted tests, lint and typecheck; commit planner and tests.

### Task 4: Bounded parallel scheduler and Pons worker adapters

**Files:** Create `be/src/indexer/jobScheduler.ts`, `be/src/indexer/jobScheduler.test.ts`, `be/src/indexer/ponsJobWorker.ts`; modify `be/src/cli/runFactoryIndexer.ts` to select the new runner behind `INDEXER_SCHEDULER=jobs` while retaining the old mode for rollback; update `be/.env.example`.

**Interfaces:** `runJobScheduler(deps: SchedulerDeps, signal: AbortSignal): Promise<void>` owns head polling, queue filling, RPC endpoint semaphores and worker lifecycle. `runPonsJob(job: ScanJob, deps: PonsJobDeps): Promise<IndexBatch>` scans exactly the assigned range with the existing factory/lifecycle/trade/V4 decoders. `claimScanJob` + `commitScanJob` are the only persisted job state transitions.

- [ ] **Step 1 — Test red:** A slow factory job does not block an independent factory job; trade waits for its upstream certified frontier; V4 pools run in bounded parallel and an old pool starts at Initialize; per-endpoint limit and 429 cooldown are enforced; worker cancellation releases or expires lease without marking complete.
- [ ] **Step 2 — Verify red:** `npm test -w be -- jobScheduler.test.ts`; expect failures.
- [ ] **Step 3 — Implement:** Build bounded scheduler and thin adapters around existing decoders. Use separate limits for shared RPC and dedicated trade endpoints; do not call `runOnce` sequentially in jobs mode. Log source/job timing and sanitized error only. Keep old runner selectable for rollback.
- [ ] **Step 4 — Verify:** Unit/integration tests, lint, typecheck, build; run a local bounded `INDEXER_ONCE=true` jobs-mode cycle on a disposable DB copy or isolated fixture DB, never beside the live writer. Commit runner and tests.

### Task 5: Near-head provisional lane and API coverage

**Files:** Modify `be/src/indexer/jobScheduler.ts`, `be/src/api/store.ts`, `be/src/api/server.ts`, `be/src/api/schemas.ts`, `be/src/db/repository.integration.test.ts`, `be/src/api/server.test.ts`; update FE coverage display only if the existing response shape cannot express incomplete windows.

**Interfaces:** Planner schedules `provisional` factory windows near safe head before history catches up; known-venue trade/lifecycle scans may write provisional records but cannot grant certified coverage. API returns `complete=false` and missing/provisional windows for requested chart/volume periods; existing launch list can show provisional launches with `coverageStatus='backfilling'`.

- [ ] **Step 1 — Test red:** New launch appears from a provisional head job while old factory gap remains; zero found trades does not produce zero complete 24h volume; chart has no invented candles; after certified replay catches up, the same launch/trade count remains and coverage becomes complete; no pool-other feature appears.
- [ ] **Step 2 — Verify red:** Run API and repository integration tests; expect failures.
- [ ] **Step 3 — Implement:** Enqueue bounded near-head windows with reserved RPC capacity and fairness for backfill. Change coverage computation from only global source status to required source/window intersections; preserve current API semantics for clients that only read `complete`/`coverageStatus`.
- [ ] **Step 4 — Verify:** Unit, integration, API/OpenAPI tests, typecheck; commit near-head and API changes.

### Task 6: Reorg fencing, migration audit, and live cutover

**Files:** Modify `be/src/indexer/reorg.ts`, `be/src/db/repository.ts`, `be/src/indexer/reorg.test.ts`, `be/src/db/repository.integration.test.ts`, `README.md`, `CLAUDE.md`.

**Interfaces:** `invalidateJobsFrom(chainId: number, forkBlock: bigint): Promise<void>` increments chain generation, rejects old leases, invalidates intersecting/downstream dependent certified and provisional windows, then retracts canonical-dependent records. Scheduler pauses affected commits until this transaction finishes.

- [ ] **Step 1 — Test red:** Fork inside a completed job invalidates its coverage; stale worker commit fails; launch/transition/Initialize/trade/candle projections after re-scan equal clean scan; existing cursor/gaps migrate without skipping a block; URL with API key never appears in persisted reason or log.
- [ ] **Step 2 — Verify red:** Run reorg unit and repository integration tests; expect failures.
- [ ] **Step 3 — Implement:** Add generation fence/invalidation and resume logic. Add operational migration validation and documented rollback to old runner; no destructive database reset. Do not restart the live process until full suite is green and a baseline/candidate comparison is recorded.
- [ ] **Step 4 — Verify and cut over:** Run `npm test -w be`, `npm run test:integration -w be`, `npm run lint -w be`, `npm run typecheck -w be`, `npm run build -w be`, `npm run openapi:check -w be`, and `git diff --check`. Stop old writer, migrate, start jobs mode, then sample cursors, job gaps, launch/trade counts, 429 rate and latency. Roll back via runner flag if correctness or throughput regresses; preserve DB.

### Task 7: Throughput and full-backfill ETA report

**Files:** Create `be/src/indexer/backfillEstimate.ts`, `be/src/indexer/backfillEstimate.test.ts`, `be/src/cli/indexerStatus.ts`; update `README.md` with the status command and a dated baseline/candidate table.

**Interfaces:** `estimateBackfill(input: { safeHead: bigint; sources: readonly SourceProgress[]; samples: readonly ThroughputSample[]; unresolvedPoolDiscovery: boolean }): BackfillEstimate` returns per-source remaining blocks and observed block/s plus a pipeline ETA range or `unreliable` reason. `SourceProgress` includes source ID, dependency group, certified frontier and start block; `ThroughputSample` includes window start/end, completed certified blocks, RPC 429 count and elapsed seconds. The CLI prints no RPC URL or secret.

- [ ] **Step 1 — Test red:** Serial dependent stages use their measured stage times while independent workers use critical-path time, not a sum; zero/short throughput sample, repeated 429, and undiscovered V4 pools yield `unreliable`; completed sources show zero remaining; safe head moving during backfill is called out in the estimate.
- [ ] **Step 2 — Verify red:** `npm test -w be -- backfillEstimate.test.ts`; expect failures.
- [ ] **Step 3 — Implement:** Persist or query timestamped job-completion metrics, compute rolling throughput from certified work only, and print per-source + whole-pipeline speed/ETA with sample interval and caveats. Record the old-runner baseline separately from new-runner candidate using the same sample windows where possible.
- [ ] **Step 4 — Verify and report:** Run targeted tests and the full backend suite; execute the status CLI after cutover, compare actual speeds and 429/gap counts, and report a range or `unreliable` rather than a false precise date. Commit code, tests and documentation.
