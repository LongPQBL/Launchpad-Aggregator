# Realtime Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every launch, curve and pool chart and related current headline figure reflects committed WebSocket events without waiting for rollup or snapshot workers.

**Architecture:** Overlay bounded dirty/current buckets from committed trades onto persisted chart history. Read current pool state at a pinned block for TVL, balance, liquidity and depth. Reuse Postgres NOTIFY and browser SSE, and extend fast-lane event coverage to state changes without swaps. Workers repair history, oracle changes and reorgs.

**Tech Stack:** TypeScript, Postgres, Drizzle, Fastify, React/Next.js, viem, SSE.

**Spec:** `docs/superpowers/specs/2026-10-16-realtime-charts-design.md`

## Global Constraints

- No guessed USD price or silent zero for unavailable data.
- API overlay work is bounded; backlog responses mark `complete=false`.
- Event delivery follows DB commit; deduplicate fast-lane and Envio rows.
- Preserve existing URL range, currency, chart style and zoom.
- Keep pre-existing uncommitted workspace edits untouched except where a task must build on them.

## Review Focus

- A trade arriving out of timestamp order must change open/close by block/log ordering; Task 1 tests this.
- A dirty bucket with unpriced trade must remain a USD gap; Task 1 tests this.
- The same swap arriving from fast lane and Envio must count once; Task 2 tests this.
- A reorg removing the last trade must remove the candle/volume point; Tasks 1 and 2 test this.
- A pool state read behind the event block must not overwrite a newer point; Task 3 tests this.

---

### Task 1: Live price buckets and chart refresh

**Files:** `be/src/market/liveCandleOverlay.ts` (new), `be/src/api/store.ts`, `be/src/pools/candleCache.ts`, `fe/src/features/launch/official-chart.tsx`, focused backend/frontend tests.

**Interfaces:** `readLiveLaunchCandles(pool, key, interval, start, end, currency, venueKind)` and `readLivePoolCandles(pool, key, interval, start, end)` return only affected buckets; their caller merges by bucket key with the persisted rows. An absent raw bucket deletes a stale cached candle.

- [ ] Write focused tests: trade in current minute appears while worker stopped; out-of-order trade yields block/log OHLC; unpriced USD trade is a gap; deleting last trade removes candle; line and candles use same updated response.
- [ ] Run focused tests and inspect the failures.
- [ ] Implement bounded API overlay and subscribe launch chart to `trade.created` as well as `launch.changed`.
- [ ] Run focused tests and TypeScript checks; inspect output.
- [ ] Commit only files belonging to this task.

### Task 2: Live volume history and rolling figures

**Files:** `be/src/charts/liveVolumeOverlay.ts` (new), `be/src/market/launchHistory.ts`, `be/src/pools/history.ts`, `be/src/api/store.ts`, `be/src/api/poolStore.ts`, `fe/src/features/pools/pool-chart-panel.tsx`, focused tests.

**Interfaces:** `overlayLaunchVolume(...)` and `overlayPoolVolume(...)` replace dirty/current bucket values with direct trade valuation and return a `complete` flag. Window totals consume the same overlay rules; all-pools aggregation excludes official pool duplicates.

- [ ] Write focused tests: worker stopped, duplicate fast/Envio delivery, unpriced side, late trade, reorg deletion and 24h/30d edge windows.
- [ ] Run focused tests and inspect failures.
- [ ] Implement bounded overlays, cache invalidation and direct `trade.created` refresh for launch volume history.
- [ ] Run focused tests and TypeScript checks; inspect output.
- [ ] Commit only task files.

### Task 3: Current TVL and balance point

**Files:** `be/src/pools/liveTvl.ts` (new), `be/src/pools/history.ts`, `be/src/market/launchHistory.ts`, `be/src/api/poolStore.ts`, `be/src/api/store.ts`, API schema/types and focused tests.

**Interfaces:** `readCurrentPoolTvl(pool, rpc, key, minimumBlock?)` returns `{ tvlUsd, blockNumber, capturedAt, balances, unavailableReason }`; history endpoints overlay only the latest bucket and return additive as-of metadata.

- [ ] Write focused tests: V2/V3/V4 latest point, launch sum, unavailable quote, RPC block behind event, older response rejection.
- [ ] Run focused tests and inspect failures.
- [ ] Implement pinned, shared, one-second coalesced RPC read; extend pool history snapshot reads to V2/V3; overlay latest point.
- [ ] Run focused tests and TypeScript checks; inspect output.
- [ ] Commit only task files.

### Task 4: Live pool/curve state event coverage

**Files:** `be/src/fastLane/decode.ts`, `be/src/fastLane/watchSet.ts`, `be/src/fastLane/runner.ts`, `be/src/fastLane/store.ts`, `be/src/envioSync/notifyChanges.ts`, focused tests.

**Interfaces:** Additional log classifiers produce a resource invalidation with block identity, `pool.changed` or `launch.changed` after commit, and the same dedupe/reorg semantics as fast-lane trades. Watch sets include verified pool catalog entries.

- [ ] Write focused tests for V4 ModifyLiquidity, V3 Mint/Burn, V2 Mint/Burn/Sync, curve lifecycle, duplicate delivery and removed logs.
- [ ] Run focused tests and inspect failures.
- [ ] Implement subscriptions, watch-set expansion, durable dedupe, repair and metrics.
- [ ] Run focused tests and TypeScript checks; inspect output.
- [ ] Commit only task files.

### Task 5: Browser integration and operational verification

**Files:** chart components, `fe/e2e/charts.spec.ts`, operational notes.

**Interfaces:** Browser chart data updates through the existing SSE resource events; no route/polling protocol change is required.

- [ ] Exercise launch quote/USD candle and line, curve price/depth/shape/volume, pool price/volume/liquidity/depth, launch/pool TVL and visible headline figures with workers paused.
- [ ] Verify hidden-tab reconnect, range switch, stale response race, unpriced value and reorg correction.
- [ ] Measure event-to-visible latency and fast-lane queue/RPC load; record gaps against the two-second post-SSE target.
- [ ] Run focused type checks and end-to-end checks; inspect output.
- [ ] Commit only task files and verification notes.
