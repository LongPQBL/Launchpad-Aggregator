# Incremental USD candles — Implementation Plan

> **Status: executed 2026-10-10** (tasks 1-5; see the spec's Measurement section). The old `usd_candles` table, `refreshUsdCandles` and `usd-candles:worker` are intentionally still present.

> **For agentic workers:** Execute task-by-task on `main` (solo project; no worktree, no sub-agents). Steps use checkbox syntax. Do not start before the chart-ranges work is verified and the user has reviewed this plan.

**Goal:** Replace the whole-token delete+re-insert of `usd_candles` with incremental, dirty-minute rollups that the USD chart reads by primary-key range.

**Architecture:** A new `launch_usd_candle_buckets` table is maintained in the same transaction as the quote candles and volume rollups (`refreshDirtyCandles`): minute buckets from trades, coarser buckets derived from the next finer one. `listUsdCandles` reads it; `usd_candles` and its worker stay until a later removal.

**Tech Stack:** PostgreSQL + Drizzle migrations, TypeScript, Vitest (`npm run -w be test`, `test:integration`).

**Spec:** `docs/superpowers/specs/2026-10-10-usd-candles-incremental-design.md`

## Global Constraints

- Work on `main`; stage only the task's files (the tree may hold unrelated uncommitted work — never `git add -A`/`git add dir/`).
- A bucket with any unpriced trade has no candle. Price per trade = `usd_value / token_amount`, oracle round at or before `(block_number, log_index)`, rejected if older than 86400 s or from the future. Official venues only; launch-wide (no venue column).
- Migrations additive only. Do not drop `usd_candles`, `refreshUsdCandles` or `usd-candles:worker` in this plan.
- Do not change a running worker's environment; document commands in README instead.

## Review Focus

- Minute where one trade is priced and one is not → no candle for that minute, nor for any coarser bucket containing it.
- Late oracle round prices a previously unpriced minute → candle appears after the dirty minute is rebuilt.
- Trade with `token_amount_raw = 0` → treated as unpriced (never divides by zero).
- Two venues trading in the same minute → open/close ordered across venues by `(block_number, log_index)`.
- Reorg deletes the only trade of a bucket → bucket and containing coarser buckets disappear.

## File Structure

- Modify `be/src/db/schema.ts`; create migration `0052`.
- Create `be/src/charts/usdCandleRollup.ts` (+integration test): `rebuildUsdCandles(client, dirty)`.
- Modify `be/src/market/candleCache.ts`: call it inside `refreshDirtyCandles`.
- Modify `be/src/charts/backfillVolume.ts`: also rebuild USD candles per launch (same minute keys).
- Create `be/src/cli/compareUsdCandles.ts`: parity report old vs new on real launches.
- Modify `be/src/api/store.ts` `listUsdCandles`; update its tests.
- Modify README.

---

### Task 1: Table and minute rebuild

**Files:** `be/src/db/schema.ts`, `be/drizzle/0052_*.sql`, `be/src/charts/usdCandleRollup.ts`, `be/src/charts/usdCandleRollup.integration.test.ts`.

**Produces:** `rebuildUsdCandles(client: PoolClient, dirty: readonly { chainId: number; tokenAddress: string; bucketStart: number }[]): Promise<void>`; table `launch_usd_candle_buckets(chain_id int, token_address text, interval_seconds int, bucket_start bigint, open/high/low/close numeric(40,20), volume_usd numeric(40,6), trade_count int, unpriced_count int)` with PK `(chain_id, token_address, interval_seconds, bucket_start)`.

- [ ] Write the failing integration test (private chain id `990005`, fixtures like `volumeRollup.integration.test.ts`: launch, curve + v4 venues, verified feed, two oracle rounds): priced minute → one row with correct OHLC/volume; add an unpriced trade → `unpriced_count = 1`; zero-amount trade → unpriced; two venues → open is the lower `(block, log)`; deleting trades then rebuilding removes the rows.
- [ ] Run `npm run -w be test:integration -- usdCandleRollup` → FAIL (module/table missing).
- [ ] Add the schema definition and `npm run -w be db:generate`; verify the SQL creates only the new table.
- [ ] Implement the 60 s step with the same CTE shape as `refreshUsdCandles` (`trade_usd` → `priced` with `usd_value`, `price = usd_value * 10^token_decimals / token_amount_raw`), grouped per minute with `(array_agg(price ORDER BY block_number, log_index))[1]` for open and `... DESC` for close, `count(*) FILTER (WHERE usd_value IS NULL)` for `unpriced_count`, `coalesce(sum(usd_value),0)` for volume; `ON CONFLICT (chain_id, token_address, interval_seconds, bucket_start) DO UPDATE`. Delete the minute's old row first.
- [ ] Implement coarser steps (300 ← 60, 3600 ← 300, 14400 ← 3600, 86400 ← 14400) with `CROSS JOIN LATERAL` over the finer rows in `[bucket, bucket + interval)`: open = first child's open (`array_agg(open ORDER BY bucket_start))[1]`), close = last child's close, `max(high)`, `min(low)`, sums; delete the coarser row first and skip when no children (`HAVING count(*) > 0`). Use the LATERAL form: a plain join with a range predicate degrades to a hash join with a join filter (measured 70 ms vs index-range for the volume rollup).
- [ ] Run → PASS. Commit `feat(charts): incremental USD candle rollup`.

### Task 2: Wire into the worker and backfill

**Files:** `be/src/market/candleCache.ts`, `be/src/charts/backfillVolume.ts`, tests `be/src/market/candleCache.integration.test.ts`, `be/src/charts/backfillVolume.integration.test.ts`.

- [ ] Tests first: `refreshDirtyCandles` on a priced trade also creates `launch_usd_candle_buckets` rows for the five intervals; `backfillLaunchVolume` creates them from existing trades.
- [ ] In `refreshDirtyCandles`, call `await rebuildUsdCandles(client, dirty)` right after `rebuildLaunchVolume`; in `backfillLaunchVolume` call it with the same minute slice inside the same transaction.
- [ ] Run unit + integration suites green. Commit `feat(charts): maintain USD candles with the candle worker`.

### Task 3: Parity report and measurement

**Files:** create `be/src/cli/compareUsdCandles.ts`; add script `"usd-candles:compare"` to `be/package.json`.

- [ ] The CLI takes `--launches N` (default 20, the most-traded launches), and for each of the five intervals compares every `usd_candles` row with the same `(token, interval, bucket_start)` row of `launch_usd_candle_buckets` (open/high/low/close within `1e-12` relative, volume within `1e-6`), skipping buckets where `unpriced_count > 0`; prints mismatches and a one-line summary; exit code 1 on any mismatch. Interval 900 is skipped (not carried over).
- [ ] Run against the dev DB after the backfill; paste the summary into the spec's "Measurement" note.
- [ ] Measure one new trade on the heaviest local token: old `refreshUsdCandles` (all six intervals) vs `rebuildUsdCandles` for its minute (`EXPLAIN (ANALYZE, BUFFERS)` / wall clock); record both numbers.
- [ ] Commit `test(charts): USD candle parity report`.

### Task 4: Switch the reader

**Files:** `be/src/api/store.ts` (`listUsdCandles`), `be/src/api/routes/launches.ts` if the response shape changes; tests `be/src/api/store.integration.test.ts`, `server.test.ts`.

- [ ] Test first: `listUsdCandles` returns the same items from the new table as the old reader did on a fixture (priced bucket present, unpriced bucket absent), newest first, window `before`/500 limit unchanged.
- [ ] Replace the `usd_candles` query with `SELECT bucket_start, open, high, low, close, volume_usd, trade_count FROM launch_usd_candle_buckets WHERE chain_id=$1 AND token_address=$2 AND interval_seconds=$3 AND bucket_start >= $4 AND bucket_start < $5 AND unpriced_count = 0 ORDER BY bucket_start DESC LIMIT 500`; remove `computedAt` from the USD candle response (`be/src/api/schemas.ts`, `UsdCandleResponse` in `be/src/api/server.ts`, and the `server.test.ts` fixture): the frontend never reads it (`grep -rn computedAt fe/src` finds only the generated schema).
- [ ] Regenerate `be/openapi.json` and `fe/src/api/schema.ts`. Full BE/FE test, tsc, lint green. Commit `feat(api): read USD candles from rollups`.

### Task 5: Docs and handoff

- [ ] README: how to run the backfill and the compare command; that `usd-candles:worker` can be stopped after the parity report is clean, and that `usd_candles` is removed in a later change.
- [ ] Update `CLAUDE.md` current-state notes (one short entry).
- [ ] Commit `docs: incremental USD candles`.
