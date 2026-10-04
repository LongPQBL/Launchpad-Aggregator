# App Trade Archive and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Planning only in this session; do not execute yet.

**Goal:** Keep recent app trades fast while retaining exact older transaction access and safely removing only verified archived rows from app PostgreSQL.

**Architecture:** A 90-day hot window is a policy target, not an unconditional delete cutoff. Immutable compressed archive objects and a verified manifest preserve canonical events and trade-time pricing; old-page readers merge archive and hot rows. Partitioning and deletion are gated by parity, sampled reads, and restore drills.

**Tech Stack:** PostgreSQL/Drizzle, Node.js TypeScript, object storage selected at implementation time, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-envio-data-coverage-pools-retention-design.md` §§ Storage and retention.

## Global Constraints

- Keep launches, venues, pool catalog, lifecycle, and source coverage for the life of supported sources. Retain `candles` and required historical price evidence.
- Archive only finalized, complete, resolved ranges older than the 90-day hot target and outside the 500-block reorg safety overlap.
- An archive object must be immutable, compressed, checksummed, and recoverable. Never delete the sole historical copy or show archive failure as an empty feed.
- Historical USD must use trade-time price/provenance or exact reconstructible inputs, never today's quote price.
- Existing `(chain_id, tx_hash, log_index)` uniqueness must remain exact across hot/archive and any new partitions.
- Migrations additive until all readers/replay paths are proven; no live DB deletion or object-store upload during this planning session.

## Review Focus

- A page whose cursor crosses the hot/archive boundary returns every trade exactly once in canonical order (Task 3).
- A failed checksum, absent object, or restore failure blocks deletion and produces an explicit API error (Tasks 2–4).
- Replay of an already archived source range does not silently reinsert old hot rows or mark coverage missing (Task 5).
- A deep reorg or old source correction invalidates the manifest/aggregate and repairs history before complete coverage returns (Task 5).
- Removing legacy `raw_logs` cannot cascade-delete a launch, venue, lifecycle row, or trade (Task 1).

## File Map and Dependencies

Create `be/src/archive/` modules for schema/codec, manifest, object-store interface, writer, reader, reconciliation, and restore. Extend `be/src/api/store.ts` trades/candles readers and Envio replay cursors. Generate additive migrations in `be/drizzle/`; measure real table/index bytes before any partition migration. The near-realtime, launch-coverage, Pools, candle, and volume-cache work must define all hot consumers before deletion is enabled. The Envio raw-DB storage plan is separate and does not authorize modifying HyperIndex tables here.

**Verification commands:** Run each named BE integration test with `cd be && npm run test:integration -- src/<named-file>.integration.test.ts`, named unit tests with `cd be && npm test -- src/<named-file>.test.ts`, and FE tests with `cd fe && npm test -- src/<named-file>.test.tsx`. Full gates are `cd be && npm test && npm run test:integration && npm run typecheck && npm run lint` and `cd fe && npm test && npm run typecheck && npm run lint`. RED must demonstrate the new behavior is absent, not a missing test DB or object-store fixture.

### Task 1: Consumer/storage audit and safe provenance migration

**Files:** Create `be/src/cli/auditStorageConsumers.ts` and report template in `docs/operations/`; modify `be/src/db/schema.ts` and generate migration only for proven provenance changes; test `be/src/db/provenance.integration.test.ts`.

- [ ] Inventory every consumer of trade columns, `source_log_id`, `raw_logs`, `scan_jobs`, `phase_observations`, candles, and price rounds; measure table/index bytes and FK cascade paths on a read-only DB.
- [ ] Test a copied schema with legacy raw-log deletion: active launch/trade/venue rows must survive after provenance is migrated to durable event keys and FKs are detached safely.
- [ ] Run targeted integration; expect RED for the unsafe legacy cascade case.
- [ ] Add immutable event provenance fields where missing and migrate in bounded resumable batches. Separate any later `DROP` of orphaned tables into a reviewed migration after backup/restore; do not drop `candles`.
- [ ] Run integration/typecheck; expect PASS. Commit audit and additive migration.

### Task 2: Archive format, provider, and verified manifest

**Files:** Create `be/src/archive/codec.ts`, `objectStore.ts`, `manifest.ts`, `archiveWriter.ts`, tests; modify `be/src/db/schema.ts`; generate migration.

**Interfaces:** `ArchiveObjectStore` has `putImmutable`, `get`, and `head`; `writeArchivePartition(tx, range): Promise<ArchiveCandidate>` produces schema-versioned compressed records with exact event key, raw amounts, block hash, token/pool identity, trader/activity, and historical price evidence. Manifest records URI, chain/source/protocol/range, key bounds, row count, checksum, schema version, and verification state.

- [ ] Compare at least two recoverable object-store choices for measured storage/GET cost and restore behavior; choose one for implementation without embedding vendor-specific schema fields.
- [ ] Test codec round-trip, corrupted bytes, duplicate keys, missing price provenance, interrupted upload, immutable write conflict, and manifest count/checksum mismatch.
- [ ] Run targeted tests; expect RED.
- [ ] Implement compressed deterministic archive serialization and transactional manifest states (`candidate`, `verified`, `invalid`); verify exact event-key set and checksum against hot rows before `verified`.
- [ ] Run targeted tests/typecheck; expect PASS. Commit.

### Task 3: Historical readers and hot/archive cursor boundary

**Files:** Create `be/src/archive/archiveReader.ts`, `archiveReader.integration.test.ts`; modify `be/src/api/store.ts`, trade routes/schemas, FE transaction loading/error state.

**Interfaces:** `listCanonicalTrades({ chainId, tokenOrPool, cursor, limit }): Promise<Page<TradeResponse>>` merges verified archive and hot table in `(blockNumber, logIndex, txHash)` order with a unique event-key dedupe guard.

- [ ] Test all-hot, all-archive, boundary-spanning, equal-position keys, absent/corrupt object, historical USD parity, chart zoom needing exact old trades, and clear FE loading/failure state.
- [ ] Run targeted BE/FE tests; expect RED.
- [ ] Route older transaction pages and exact historical chart zoom to archive while keeping recent/24h reads hot; reject unverified or unavailable objects explicitly. Keep compact hourly/daily aggregates for older charts and 52-week high/low before archiving source trades.
- [ ] Run BE integration/typecheck and FE tests/typecheck; expect PASS. Commit.

### Task 4: Finality/partition benchmark and deletion gate

**Files:** Create `be/src/archive/retentionGate.ts`, `retentionGate.integration.test.ts`, `be/src/cli/benchmarkTradePartitioning.ts`, `be/src/cli/archiveFinalizedTrades.ts`.

**Interfaces:** `canDeleteHotPartition(range): Promise<{ allowed: boolean; reasons: string[] }>` requires complete/finalized source ranges, verified aggregates, verified manifest, matching key count/checksum, sampled old-page read, successful restore drill, and safety overlap. CLI defaults to dry run and requires explicit `--delete-verified` plus a disposable/test DB guard during development.

- [ ] Test each missing gate independently, including pending-source range, within-500-block range, failed checksum, missing archive, no restore drill, and a passing closed partition.
- [ ] Run targeted integration; expect RED.
- [ ] Benchmark monthly partitioning against the current primary key; write a migration strategy that preserves global dedupe and existing FK readers. Use bounded partition operations only after every gate passes. Record latency/storage deltas.
- [ ] Run targeted integration and disposable-DB delete/restore drill; expect PASS. Do not run deletion on the existing app DB. Commit.

### Task 5: Replay, parity union, deep correction

**Files:** Modify `be/src/envioSync/incrementalCursor.ts` or successor, `be/src/coverage/launchParity.ts`/trade parity modules; create `be/src/archive/reconcile.ts` and integration tests.

- [ ] Test restart/replay below archived boundary, old event present only in archive, Envio correction/deep reorg, missing manifest file, and targeted restore/rearchive with aggregate invalidation.
- [ ] Run targeted integration; expect RED.
- [ ] Store archived finalized boundary per source; compare canonical keys against hot rows **union verified archive manifests**, with file-level checks for disagreements. Deep corrections invalidate impacted archive/aggregate state and coverage until rebuilt.
- [ ] Run integration/typecheck/lint; expect PASS. Commit.

### Task 6: Measured operational cutover (separate future go/no-go)

- [ ] On a disposable database, demonstrate 90-day cutoff, old-page pagination, chart/high-low, historical USD, parity, archive retrieval failure, and full restore after DB rows are gone.
- [ ] Record archive cost, hot DB size, read latency, checksum/restore evidence, and deletion rate. Review the concrete results and backup before any live DB migration or deletion; this plan does not itself authorize that operational action.
