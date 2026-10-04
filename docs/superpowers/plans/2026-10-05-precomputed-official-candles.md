# Precomputed Official Candles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist official Pons OHLCV candles before old individual trades are eligible for archival.

**Architecture:** A Postgres trigger queues the affected one-minute bucket whenever an app trade changes. A separate bounded worker rebuilds all supported candle intervals from canonical official trades, then removes queued keys in the same transaction. The API reads persisted candles after a resumable historical backfill and reports incomplete coverage while a requested bucket is dirty or contains an unpriced trade.

**Tech Stack:** Node.js 24, TypeScript, PostgreSQL, Drizzle, Fastify, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-envio-data-coverage-pools-retention-design.md`

## Global Constraints

- Use Envio-derived app trades; do not restore the removed RPC indexer.
- Official launch candles include only Pons-designated venues.
- Preserve `(blockNumber, logIndex)` order and exact quote amounts.
- Never show zero or a stale candle when price data or refresh is pending.
- Do not delete old trades in this work unit.

## Review Focus

- Reorg deletes a trade: affected candle must be rebuilt or hidden until rebuilt.
- An unpriced trade shares a bucket with priced trades: omit that candle and mark response incomplete.
- Trades from a non-official pool: must not change official candles.
- Multiple trades in one block: opening/closing price follows log index.
- Worker crashes between candle write and queue removal: transaction rolls back, so retry is safe.

---

### Task 1: Dirty bucket migration

**Files:** `be/src/db/schema.ts`, `be/drizzle/0024_*.sql`, `be/drizzle/0025_*.sql`, `be/drizzle/0026_*.sql`, `be/src/market/candleCache.integration.test.ts`

- [x] Add `candle_dirty_buckets(chain_id, token_address, bucket_start)` primary key and an index to claim oldest work.
- [x] Trigger `trades` INSERT/DELETE/UPDATE to enqueue the old and new one-minute keys; use `ON CONFLICT DO NOTHING`.
- [x] Test inserting and deleting a trade creates a dirty key; rerunning the same event does not duplicate it.

### Task 2: Bounded recomputation and historical seed

**Files:** `be/src/market/candleCache.ts`, `be/src/market/candleCache.integration.test.ts`, `be/src/cli/backfillCandles.ts`, `be/package.json`

- [x] Write tests for 60/300/900/3600/86400-second candles, high/low, exact quote sum, reorg deletion, unpriced bucket, and non-official venue.
- [x] Implement `refreshDirtyCandles(pool: Pool, limit: number): Promise<number>` with `FOR UPDATE SKIP LOCKED`, canonical trade reads, and atomic upsert/delete of affected candle keys.
- [x] Add a resumable CLI that enqueues historical one-minute keys in bounded timestamp windows and drains the queue; never scan or delete user data without an explicit CLI run.
- [x] Run focused integration tests and typecheck.

### Task 3: API and Envio sync integration

**Files:** `be/src/api/store.ts`, `be/src/market/candleCache.integration.test.ts`, `be/src/cli/runCandleWorker.ts`, `README.md`

- [x] Test the API reads persisted rows, marks a dirty/unpriced page incomplete, and never returns stale affected candles.
- [x] Use a bounded cached query in `listCandles` after backfill; preserve the prior read-time path until then.
- [x] Run candle refresh as a separate process from Envio sync, with bounded work and retry on failure so candles cannot block launch/trade insertion.
- [x] Run integration tests, unit tests, lint, and typecheck; leave the old trade table intact.
