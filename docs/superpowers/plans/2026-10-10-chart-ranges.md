# Chart ranges and rollup-backed chart data — Implementation Plan

> **For agentic workers:** Execute task-by-task, in order, on `main` (solo project, no worktree, no sub-agents). Steps use checkbox syntax.

**Goal:** Price / Volume / TVL charts use time-range tabs (1H 1D 1W 1M 1Y) and read pre-aggregated rollups instead of raw trades.

**Architecture:** Backend owns one `range → (window, bucket)` map. Volume and TVL are maintained incrementally in new rollup tables (volume piggybacks on the existing dirty-minute claim in the candle workers; TVL upserts at snapshot time). Reads are primary-key range scans. Frontend sends only `range` and draws Volume (histogram) / TVL (area) with Lightweight Charts.

**Tech Stack:** Node 24, TypeScript, Fastify, PostgreSQL + Drizzle migrations, Vitest (unit + `npm run -w be test:integration`), Next.js/React, Lightweight Charts.

**Spec:** `docs/superpowers/specs/2026-10-10-chart-ranges-design.md`

## Global Constraints

- Work directly on `main`; commit only the files of the task (the tree has unrelated uncommitted changes — never `git add -A`).
- `null` = unavailable, never zero. No candle/bar for a no-trade gap. Bucket with any unpriced trade → `null` volume.
- Migrations additive only; do not drop or prune existing tables/rows. Do not change any running worker's environment.
- Frontend copy English; identifiers/tests English. Generated files (`be/openapi.json`, `fe/src/api/schema.ts`) regenerate via `openapi:write` / `generate:schema`, never hand-edited.
- Range map (exact): `1h`→3600s window/60s bucket, `1d`→86400/300, `1w`→604800/3600, `1m`→2592000/14400, `1y`→31536000/86400.
- Existing candle interval 900 stays; only 14400 is added.

## Review Focus

- Pool with no verified USD feed → volume `null` per bucket, not `0`.
- Late oracle round arrives after the trade → bucket flips from `null` to a value (re-dirtied).
- Trade deleted by reorg → minute and coarser buckets shrink/disappear.
- Launch with zero trades in range, coverage complete → bars are real `0`; coverage incomplete → `null`.
- TVL range 1m/1y for a pool with snapshots only for 2 days → remaining buckets `null`, response still 200.
- `range` missing/invalid → default `1d` / 400 respectively; never a 500.

## File Structure

- Create `be/src/charts/ranges.ts` (+test): the range map and helpers.
- Modify `be/src/pools/history.ts`: `HISTORY_INTERVALS` += 14400, `MAX_HISTORY_BUCKETS` = 400; pool history reads rollups.
- Create `be/src/charts/volumeRollup.ts` (+integration test): rebuild launch/pool volume buckets for dirty minutes.
- Modify `be/src/market/candleCache.ts`, `be/src/pools/candleCache.ts`: add 14400; call the volume rollup in the same transaction.
- Modify `be/src/market/launchHistory.ts`: launch history reads rollups.
- Modify `be/src/pools/tvlSnapshots.ts`: upsert `pool_tvl_buckets`.
- Modify `be/src/db/schema.ts`; create migration `0050`.
- Create `be/src/cli/backfillVolumeBuckets.ts`: resumable historical backfill.
- Modify `be/src/api/routes/launches.ts`, `routes/pools.ts`, `schemas.ts`, `store.ts`, `poolStore.ts`: `range` param.
- Modify `be/src/cli/runUsdCandleWorker.ts`: interval list += 14400.
- Frontend: `fe/src/api/client.ts`, `fe/src/features/launch/official-chart.tsx`, `launch-chart-panel.tsx`, `official-price-chart.tsx`, `fe/src/features/pools/pool-chart-panel.tsx`, `pool-chart.tsx`, `pool-history-chart.tsx` (rewrite on Lightweight Charts), the launch/pool pages, README.

---

### Task 1: Range map and interval constants

**Files:** Create `be/src/charts/ranges.ts`, `be/src/charts/ranges.test.ts`; modify `be/src/pools/history.ts:7-9`.

**Produces:** `type ChartRange = '1h'|'1d'|'1w'|'1m'|'1y'`; `CHART_RANGES`; `DEFAULT_RANGE='1d'`; `parseRange(value: unknown): ChartRange | null`; `rangeSpec(range): { windowSeconds: number; intervalSeconds: number; buckets: number }`.

- [ ] Write `ranges.test.ts`: each range maps to the exact table above; `buckets === windowSeconds / intervalSeconds`; `parseRange('1D')`/`''`/`undefined`/`'5m'` → `null`.
- [ ] Run `npm run -w be test -- ranges` → FAIL (module missing).
- [ ] Implement:

```ts
export const CHART_RANGES = ['1h', '1d', '1w', '1m', '1y'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const DEFAULT_RANGE: ChartRange = '1d';
const SPECS = {
  '1h': { windowSeconds: 3_600, intervalSeconds: 60 },
  '1d': { windowSeconds: 86_400, intervalSeconds: 300 },
  '1w': { windowSeconds: 604_800, intervalSeconds: 3_600 },
  '1m': { windowSeconds: 2_592_000, intervalSeconds: 14_400 },
  '1y': { windowSeconds: 31_536_000, intervalSeconds: 86_400 },
} as const;
export function parseRange(value: unknown): ChartRange | null {
  return typeof value === 'string' && (CHART_RANGES as readonly string[]).includes(value) ? (value as ChartRange) : null;
}
export function rangeSpec(range: ChartRange) {
  const spec = SPECS[range];
  return { ...spec, buckets: spec.windowSeconds / spec.intervalSeconds };
}
```

- [ ] In `history.ts`: `HISTORY_INTERVALS = [60, 300, 900, 3600, 14400, 86400]`, `MAX_HISTORY_BUCKETS = 400`.
- [ ] `npm run -w be test` (unit) green; `npx tsc --noEmit -p be` clean. Commit `feat(charts): add chart range map`.

### Task 2: Schema and migration 0050

**Files:** modify `be/src/db/schema.ts`; generate `be/drizzle/0050_*.sql`; test `be/src/db/schema.migration.integration.test.ts` (extend).

New tables (Drizzle definitions mirror spec): `launch_volume_buckets` (`chain_id int, token_address text, venue_kind text, interval_seconds int, bucket_start bigint, volume_usd numeric(40,6), trade_count int, unpriced_count int`; PK on first five key columns plus `bucket_start`; partial index `(chain_id, token_address) WHERE unpriced_count > 0` named `launch_volume_unpriced_idx`), `pool_volume_buckets` (`chain_id, protocol, pool_id, interval_seconds, bucket_start, trade_count, usd_scaled0 numeric(60,12) null, unpriced0 int, usd_scaled1 numeric(60,12) null, unpriced1 int`; PK key columns), `pool_tvl_buckets` (`chain_id, protocol, pool_id, interval_seconds, bucket_start, tvl_usd numeric(78,30), last_captured_at timestamptz`; PK key columns; check `protocol='uniswap_v4'`), `chart_rollup_state` (`name text pk, completed_through bigint`).

- [ ] Add definitions; `npm run -w be db:generate`; inspect the SQL.
- [ ] Append hand-written data/constraint steps to the generated file (after `--> statement-breakpoint`):

```sql
ALTER TABLE "usd_candles" DROP CONSTRAINT "usd_candles_interval_valid";
--> statement-breakpoint
ALTER TABLE "usd_candles" ADD CONSTRAINT "usd_candles_interval_valid" CHECK ("interval_seconds" IN (60, 300, 900, 3600, 14400, 86400));
--> statement-breakpoint
INSERT INTO candles (chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, quote_volume_raw)
SELECT chain_id, token_address, 14400, (bucket_start / 14400) * 14400,
  (array_agg(open ORDER BY bucket_start))[1],
  (array_agg(high ORDER BY high::numeric DESC))[1],
  (array_agg(low ORDER BY low::numeric ASC))[1],
  (array_agg(close ORDER BY bucket_start DESC))[1],
  sum(quote_volume_raw)
FROM candles WHERE interval_seconds = 3600
GROUP BY chain_id, token_address, (bucket_start / 14400) * 14400
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO pool_candles (chain_id, protocol, pool_id, interval_seconds, bucket_start,
  open_sqrt_price_x96, high_sqrt_price_x96, low_sqrt_price_x96, close_sqrt_price_x96, trade_count)
SELECT chain_id, protocol, pool_id, 14400, (bucket_start / 14400) * 14400,
  (array_agg(open_sqrt_price_x96 ORDER BY bucket_start))[1], max(high_sqrt_price_x96), min(low_sqrt_price_x96),
  (array_agg(close_sqrt_price_x96 ORDER BY bucket_start DESC))[1], sum(trade_count)
FROM pool_candles WHERE interval_seconds = 3600
GROUP BY chain_id, protocol, pool_id, (bucket_start / 14400) * 14400
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO pool_tvl_buckets (chain_id, protocol, pool_id, interval_seconds, bucket_start, tvl_usd, last_captured_at)
SELECT DISTINCT ON (chain_id, protocol, pool_id, i.step, (extract(epoch FROM captured_at)::bigint / i.step) * i.step)
  chain_id, protocol, pool_id, i.step, (extract(epoch FROM captured_at)::bigint / i.step) * i.step, tvl_usd, captured_at
FROM pool_tvl_snapshots s CROSS JOIN (VALUES (3600), (14400), (86400)) AS i(step)
ORDER BY chain_id, protocol, pool_id, i.step, (extract(epoch FROM captured_at)::bigint / i.step) * i.step, captured_at DESC
ON CONFLICT DO NOTHING;
```

- [ ] Extend the migration integration test: tables exist; `usd_candles` accepts 14400; inserting 3 hourly `candles` rows then re-running the 4h backfill SELECT yields one 4h row with correct open/high/low/close/volume (run the SELECT in the test against fixture rows in a private chain id).
- [ ] `npm run -w be test:integration -- schema.migration` green. Commit `feat(db): chart rollup tables and 4h interval`.

### Task 3: Volume rollup writer

**Files:** create `be/src/charts/volumeRollup.ts`, `be/src/charts/volumeRollup.integration.test.ts`.

**Produces:**
```ts
export const VOLUME_INTERVALS = [60, 300, 3600, 14400, 86400] as const;
export async function rebuildLaunchVolume(client: PoolClient, dirty: readonly { chainId: number; tokenAddress: string; bucketStart: number }[]): Promise<void>;
export async function rebuildPoolVolume(client: PoolClient, dirty: readonly { chainId: number; protocol: string; poolId: string; bucketStart: number }[]): Promise<void>;
```
`bucketStart` are minute starts. Each function (a) deletes then re-inserts the 60 s rows for each dirty minute, (b) for each coarser interval recomputes the containing bucket from the next finer interval table rows (`300` from `60`, `3600` from `300`, `14400` from `3600`, `86400` from `14400`), deleting a coarser row when no finer rows remain.

Launch minute SQL (per dirty key; USD rule identical to `readLaunchHistory`/`usd_candles`: latest oracle round at or before the trade's `(block_number, log_index)`, rejected when `timestamp - updated_at < 0 or > 86400`):

```sql
INSERT INTO launch_volume_buckets (chain_id, token_address, venue_kind, interval_seconds, bucket_start, volume_usd, trade_count, unpriced_count)
SELECT $1, $2, v.kind, 60, $3, coalesce(sum(usd), 0), count(*), count(*) FILTER (WHERE usd IS NULL)
FROM (
  SELECT v.kind, CASE WHEN r.answer_raw IS NULL OR l.quote_asset_decimals IS NULL OR t.timestamp - r.updated_at < 0 OR t.timestamp - r.updated_at > 86400 THEN NULL
    ELSE t.quote_amount_raw::numeric * r.answer_raw::numeric / power(10::numeric, l.quote_asset_decimals + r.decimals) END AS usd
  FROM trades t
  JOIN venues v ON v.id = t.venue_id AND v.official = true
  JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
  LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address AND f.verification_status = 'verified'
  LEFT JOIN LATERAL (SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
    WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
    ORDER BY block_number DESC, log_index DESC LIMIT 1) r ON true
  WHERE t.chain_id = $1 AND t.token_address = $2 AND t.timestamp >= $3 AND t.timestamp < $3 + 60
) x GROUP BY kind
```
(group alias fixed when writing: select `x.kind`.) Pool minute SQL: same shape over `pool_trades`, computed once per side (`amount0_raw` with `currency0`'s feed, `amount1_raw` with `currency1`'s feed via `resolveVerifiedFeed`-equivalent join on `quote_usd_feeds` by the pool's currency), `usd_scaled = sum(abs(amount_raw) * answer_raw / power(10, feed_decimals))`, `unpriced = count(*) filter (where usd is null)`; side without a verified feed → `usd_scaled NULL, unpriced = trade_count`.

Coarser rollup SQL (launch; pool analogous, summing both sides):
```sql
INSERT INTO launch_volume_buckets (...) SELECT chain_id, token_address, venue_kind, $4, $3, sum(volume_usd), sum(trade_count), sum(unpriced_count)
FROM launch_volume_buckets WHERE chain_id=$1 AND token_address=$2 AND interval_seconds=$5 AND bucket_start >= $3 AND bucket_start < $3 + $4
GROUP BY chain_id, token_address, venue_kind
ON CONFLICT (chain_id, token_address, venue_kind, interval_seconds, bucket_start) DO UPDATE SET volume_usd=EXCLUDED.volume_usd, trade_count=EXCLUDED.trade_count, unpriced_count=EXCLUDED.unpriced_count
```
preceded by `DELETE` of that coarser row so a vanished child removes it.

- [ ] Write integration tests (private chain id `990001`, fixtures: launch, official venue, feed, 2 oracle rounds, trades): priced minute volume correct; second trade in the same minute adds; unpriced trade → `unpriced_count=1`; day bucket equals sum of minute buckets; deleting the trade then rebuilding removes minute and day rows; curve vs v4_pool rows separate; pool with no feed → `unpriced = trade_count`, `usd_scaled NULL`.
- [ ] Run → FAIL; implement; run → PASS. Commit `feat(charts): incremental volume rollup`.

### Task 4: Wire rollups into workers and TVL snapshots

**Files:** modify `be/src/market/candleCache.ts` (add `14400` to `CANDLE_INTERVALS`; in `refreshDirtyCandles` call `await rebuildLaunchVolume(client, dirty)` before the dirty delete), `be/src/pools/candleCache.ts` (add `14400`; call `rebuildPoolVolume` inside `refreshDirtyPoolCandles` before the dirty delete), `be/src/pools/tvlSnapshots.ts`, `be/src/cli/runUsdCandleWorker.ts` (`intervals` += 14400); tests: extend `candleCache.integration.test.ts` (both) and `tvlSnapshots.integration.test.ts`.

TVL upsert added to `insertTvlSnapshot` after the snapshot insert:
```ts
for (const step of [3600, 14400, 86400]) {
  await pool.query(`INSERT INTO pool_tvl_buckets (chain_id, protocol, pool_id, interval_seconds, bucket_start, tvl_usd, last_captured_at)
    VALUES ($1,$2,$3,$4,($5::bigint / $4) * $4, $6, to_timestamp($5))
    ON CONFLICT (chain_id, protocol, pool_id, interval_seconds, bucket_start) DO UPDATE
      SET tvl_usd = EXCLUDED.tvl_usd, last_captured_at = EXCLUDED.last_captured_at
      WHERE EXCLUDED.last_captured_at >= pool_tvl_buckets.last_captured_at`,
    [snapshot.chainId, snapshot.protocol, snapshot.poolId.toLowerCase(), step, snapshot.capturedAtSeconds, snapshot.tvlUsd]);
}
```
- [ ] Tests first: refreshing a dirty minute also produces volume rows (both stores); a 14400 candle exists after refresh; two snapshots in one hour leave the later value; an older snapshot arriving later does not overwrite.
- [ ] Implement, run unit + integration tests green, commit `feat(charts): maintain volume and TVL rollups`.

### Task 5: Historical backfill CLI

**Files:** create `be/src/cli/backfillVolumeBuckets.ts`, `be/src/charts/backfillVolume.ts` (+integration test); add npm script `"charts:backfill-volume": "tsx --env-file-if-exists=.env src/cli/backfillVolumeBuckets.ts"` to `be/package.json`.

`backfillVolume(pool, { launchLimitDays, batch })`: reads `chart_rollup_state` row `volume_buckets` (`completed_through`, default earliest trade timestamp floored to day), then for each UTC day until now: selects `DISTINCT chain_id, token_address, (timestamp/60)*60` from official-venue trades (and the pool equivalent from `pool_trades`) in that day, calls `rebuildLaunchVolume` / `rebuildPoolVolume` in transactions of ≤500 keys, then updates `completed_through`. Idempotent (rebuild deletes/reinserts) and resumable.
- [ ] Test: two days of fixture trades → buckets exist; second run is a no-op; killing after day 1 (state row) and re-running completes day 2.
- [ ] Implement; commit `feat(charts): resumable volume bucket backfill`. README gets the command in the "candles" section.

### Task 6: Rollup-backed history readers

**Files:** modify `be/src/market/launchHistory.ts`, `be/src/pools/history.ts`; update `launchHistory.integration.test.ts`, `history.integration.test.ts`.

`readLaunchHistory(pool, { chainId, tokenAddress, range, asOf, complete, venueKind? })` and `readPoolHistory(pool, key, { range, asOf, rpcClient })` (replace `intervalSeconds/buckets` options and drop `readPoolDailyHistory`'s separate path; `poolStore.ts` day-30 volume uses `range: '1m'` and the 1d interval is replaced — keep a thin `readPoolDailyHistory(days)` wrapper that calls the new reader with interval 86400 so the 30-day pool metric keeps working).

Returned shape adds `intervalSeconds`. Launch volume query:
```sql
SELECT bucket_start, sum(volume_usd) AS volume_usd, sum(trade_count)::int AS trade_count, sum(unpriced_count)::int AS unpriced
FROM launch_volume_buckets WHERE chain_id=$1 AND token_address=$2 AND interval_seconds=$3 AND bucket_start >= $4 AND bucket_start < $5
  AND ($6::text IS NULL OR venue_kind=$6) GROUP BY bucket_start
```
Bucket value = `unpriced > 0 ? null : volume_usd` (trimmed zeros). Missing bucket = `'0'` when `complete`, else `null`. `complete` additionally false when `candle_dirty_buckets` has any row for the token within the window. Pool volume: pick priced side as today, value = `usd_scaledN / 10^decimals`, `unpricedN > 0` → null. TVL: `range` 1h/1d → raw `pool_tvl_snapshots` grouped to the bucket (`DISTINCT ON`), 1w/1m/1y → `pool_tvl_buckets`; launch TVL via official V4 `venues` join as before.

- [ ] Rewrite integration tests with rollup fixtures: values equal the previous raw-trade query on the same fixtures (parity), null for unpriced, `0` vs `null` by `complete`, TVL ranges, dirty bucket → `complete=false`.
- [ ] Implement, delete old raw-trade queries, tests green. Commit `feat(charts): history reads from rollups`.

### Task 7: API `range` parameter

**Files:** modify `be/src/api/routes/launches.ts`, `routes/pools.ts`, `schemas.ts`, `store.ts` (`listLaunchHistory` signature → `{ range, venueKind? }`), `poolStore.ts` (`listPoolHistory(key, { range })`), `ttlMemo` usage; update `server.test.ts`, `pools.integration.test.ts`, `store.integration.test.ts`; regenerate `be/openapi.json` and `fe/src/api/schema.ts`.

- History routes: `range` query (default `1d`); invalid → 400 `Invalid history range`; remove `intervalSeconds`/`days` and the `HISTORY_BUCKETS` tables. `poolHistory` schema gains `intervalSeconds: integer`.
- Candle routes (launch and pool): accept `range`; when present it overrides `intervalSeconds` (interval from `rangeSpec`), forces no `before`, and trims `items` to `bucketStart >= now - windowSeconds`. `usd` currency honored. Invalid `range` → 400 `Invalid candle range`. Allowed `intervalSeconds` lists gain 14400.
- Memo: wrap history/candle-by-range reads in `ttlMemo` keyed `subject|range` with TTLs 1h 5s, 1d 15s, 1w 60s, 1m/1y 300s (follow the existing `ttlMemo` usage in `store.ts`).
- [ ] Tests first for: default range, invalid range 400, candle trim, memo returns identical object within TTL. Implement, regenerate schemas (`npm run -w be openapi:write`, `npm run -w fe generate:schema`), all BE tests green. Commit `feat(api): range-based chart endpoints`.

### Task 8: Frontend data layer and range tabs

**Files:** modify `fe/src/api/client.ts` (+`client.test.ts`), `fe/src/features/launch/official-chart.tsx` (replace `CHART_INTERVALS`/interval state with `CHART_RANGES = [{id:'1h',label:'1H'},…]`, `DEFAULT_CHART_RANGE='1d'`, `ChartIntervalTabs` → `ChartRangeTabs`, URL param `range`), `official-price-chart.tsx`, `pool-chart.tsx`, the launch page (`fe/src/app/launches/[chainId]/[tokenAddress]/page.tsx`, `curve/page.tsx`) and pool page, `launch-detail.tsx`/`pool-detail.tsx` props (`chartInterval` → `chartRange`), `fe/src/lib/format` axis-time helper if needed.

API: `getLaunchCandles(chainId, token, { currency, range, venue })`, `getPoolCandles(pool, range)`, `getPoolHistory(pool, range)`, `getLaunchHistory(chainId, token, range, venue)` — each sends `range`, never `intervalSeconds`.
- [ ] Update/extend tests (`client.test.ts`, `official-chart.test.tsx`, `pool-chart.test.tsx`, `launch-detail.test.tsx`, `pools.test.tsx`) to the new tab labels (`1H 1D 1W 1M 1Y`), default `1D`, URL `?range=`.
- [ ] Implement; `npm run -w fe test`, `tsc --noEmit`, lint clean for touched files. Commit `feat(fe): chart range tabs`.

### Task 9: Volume and TVL charts on Lightweight Charts

**Files:** rewrite `fe/src/features/pools/pool-history-chart.tsx` (keep file/export name `PoolHistoryChart` so panels stay wired; update tests `pool-history-chart.test.tsx`, `pool-chart-panel.test.tsx`), modify `pool-chart-panel.tsx` (`loadHistory(range)`, shared range state across kinds, TVL tab only when `showTvl`).

Behavior: Volume = `HistogramSeries`, TVL = `AreaSeries`, color from the CSS token `--color-success` read at mount (`getComputedStyle`), re-read on theme change; `null` bucket → whitespace point (no bar); right price scale formatted with `formatUsdCompact`; time scale UTC labels (`Oct 3` for 1M/1Y, `14:30` for 1H/1D/1W) via `localization.timeFormatter` + `tickMarkFormatter`; header top-left: label ("Volume"/"TVL"), large figure (`RollingText`), time below; crosshair move swaps figure/time (a `null` hovered bucket → "Unavailable"); not hovering: Volume = window total or "Unavailable" if any bucket is `null`, TVL = latest non-null value or "Unavailable". Coverage note kept when `!complete`; TVL empty-state text "TVL history starts when snapshots began." Chart created once, data updated via `setData` (same pattern as `official-chart.tsx`).
- [ ] Tests: renders three kinds without throwing in jsdom (mock `lightweight-charts` like `official-chart.test.tsx` does); readout total vs hover vs unavailable; `null` buckets excluded from series data; range change refetches and uses cache on return.
- [ ] Implement; FE test/tsc/lint green. Commit `feat(fe): histogram volume and area TVL charts`.

### Task 10: Docs, verification, measurement

- [ ] README (Vietnamese section for solo dev): `charts:backfill-volume` command, `POOL_TVL_SNAPSHOT_INTERVAL_SECONDS=60` recommendation (not applied), range table.
- [ ] Apply migration 0050 to the local dev DB (`npm run -w be db:migrate`) and run `charts:backfill-volume`; record row counts.
- [ ] Measure with `EXPLAIN (ANALYZE, BUFFERS)` the 1Y launch volume read and 1D pool volume read on the heaviest local token before (git stash not needed: run old query text from `git show HEAD~N`) and after; add the numbers to the spec's "Measurement" note.
- [ ] Full checks: `npm run -w be test`, `test:integration`, `npm run -w fe test`, both `tsc --noEmit`, lint. Playwright e2e only if port 3000 free; otherwise state not run. Run the dev servers and look at the three charts on a real launch and a real pool in the browser.
- [ ] Commit `docs: chart ranges README and measurements`.

### Task 11: Follow-up spec and plan for `usd_candles`

After Tasks 1-10 verify: write `docs/superpowers/specs/2026-10-1x-usd-candles-incremental-design.md` and a matching plan (incremental dirty-minute rebuild for `usd_candles` with an oracle-attached price per trade, venue dimension, retire the whole-token delete+insert). Commit both; do not implement.
