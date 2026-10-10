# Chart ranges (1H / 1D / 1W / 1M / 1Y) and rollup-backed chart data

Date: 2026-10-10. Status: draft for review.

## Goal

The launch and pool charts (Price, Volume, TVL) switch from "candle size" tabs (1m/5m/15m/1h/1D) to
**time-range tabs: 1H, 1D, 1W, 1M, 1Y**, like Uniswap's token page. The server picks the bucket size for a
range. Every chart read must be cheap for PostgreSQL: a primary-key range scan over a small pre-aggregated
table, never a scan of raw trades plus a per-trade oracle lookup.

Not changing: the honesty rules. `null` means unavailable, never zero; no candle or bar is invented for a
no-trade interval; `complete` reports indexing coverage; official-venue volume and all-pools token volume stay
separately labeled.

## Range contract

One mapping, owned by the backend (`be/src/charts/ranges.ts`); the frontend only sends `range`.

| range | window (ending now) | bucket | max points |
|---|---|---|---|
| `1h` | 1 hour | 60 s | 60 |
| `1d` | 24 hours | 300 s | 288 |
| `1w` | 7 days | 3600 s | 168 |
| `1m` | 30 days | 14400 s | 180 |
| `1y` | 365 days | 86400 s | 365 |

- Query param `range` replaces `intervalSeconds`/`days` on the launch/pool **history** endpoints. The **candle**
  endpoints gain `range` (the frontend uses only it) and keep `intervalSeconds`/`before` for existing tests and
  the USD path. OpenAPI and `fe/src/api/schema.ts` regenerate. History responses also return `intervalSeconds`.
- Responses return the whole window in one page (no `before` pagination). Zooming/panning past the window is out of scope.
- `HISTORY_INTERVALS` gains 14400; `MAX_HISTORY_BUCKETS` rises to 400.

## Data reads (the DB-efficiency part)

Today's costs, measured by reading the code:
- `readLaunchHistory` / `readPoolHistory` join every trade in the window to its oracle round with a
  `LEFT JOIN LATERAL` on each request. A 1Y daily request therefore touches a year of trades.
- `usd_candles` is rebuilt for the whole token (`DELETE` + full `INSERT … SELECT`) per interval.
- Launch candles read `candles` (cache) only without a venue scope; otherwise raw trades.

Principle: **write path does incremental rollups; read path reads rollups.**

### Volume

New tables (additive migration):

- `launch_volume_buckets(chain_id, token_address, venue_kind, interval_seconds, bucket_start, volume_usd, trade_count, unpriced_count)`
  PK `(chain_id, token_address, venue_kind, interval_seconds, bucket_start)`. `venue_kind` ('curve' | 'v4_pool')
  lets the curve-only chart and the all-official chart both read it (all-official = sum of kinds at read time).
- `pool_volume_buckets(chain_id, protocol, pool_id, interval_seconds, bucket_start, trade_count, usd_scaled0, unpriced0, usd_scaled1, unpriced1)`
  PK `(chain_id, protocol, pool_id, interval_seconds, bucket_start)`. A pool's token decimals are only known via
  RPC, which the rollup worker does not have, so each side stores `sum(abs(amount_raw) * answer_raw / 10^feed_decimals)`
  (decimals-free); the reader divides by `10^decimals` of whichever side it prices (same side choice as today).
- `unpriced_count > 0` ⇒ the API returns `volumeUsd = null` for that bucket (same rule as today).
  Partial index on `unpriced_count > 0` lets a new oracle round re-dirty only buckets that were waiting for a price.

Intervals stored: 60, 300, 3600, 14400, 86400 (exactly the five range buckets).

Maintenance, reusing the existing dirty-bucket pattern (`candle_dirty_buckets`, `pool_candle_dirty_buckets`,
`FOR UPDATE SKIP LOCKED`):
- The 60 s bucket is built from the trades of that minute (one valuation with the existing oracle rule).
- Each coarser interval is rebuilt **from the next finer table** (5 m from 60 s, 1 h from 5 m, 4 h from 1 h,
  1 d from 4 h), so a busy token never re-reads a day of trades to update today's daily bar.
- Same transaction as the existing candle rebuild where practical, so one dirty claim feeds candles and volume.
- Reorg/late trade: the existing dirty marking already re-queues the minute; coarser buckets rebuild from it.
- Backfill: a resumable per-day CLI like `candles:backfill`, run once per chain.

Retention (new tables only; they are rebuildable from trades): 60 s kept 24 h, 5 m 3 d, 1 h 14 d, 4 h 60 d,
1 d forever. A late rebuild may recreate an old row transiently; the pruner removes it. Existing `candles` /
`pool_candles` are not pruned by this work.

### Price (quote-denominated)

- Launch: read `candles` (per token) and `pool_candles` (per pool) for the range's bucket; add interval 14400 to both.
  Venue-scoped (curve) price requests currently fall back to raw trades; they use a venue-keyed read of
  the same rollup if the existing cache is extended with `venue_kind`, otherwise stay on the bounded trades
  path (window ≤ 1 y of one token's curve trades, which stop at sweep). Decide during planning after measuring.
- Candle rebuilds keep today's per-interval rebuild from trades (only interval 14400 is added, and the
  existing 900 stays so old data and tests are untouched). Deriving candles from finer intervals is a
  measured follow-up, not part of this change.
- USD price candles (`usd_candles`) keep today's path for this change; its whole-token rebuild is a known cost
  to address as a separate work unit (flag in plan).

### TVL

- Raw `pool_tvl_snapshots` stay the source for 1H and 1D: captured every **60 s** (set
  `POOL_TVL_SNAPSHOT_INTERVAL_SECONDS=60`; the code minimum already allows it; documented in README, not
  changed on any running environment by this work). Raw retention stays 168 h.
- New `pool_tvl_buckets(chain_id, protocol, pool_id, interval_seconds, bucket_start, tvl_usd, last_captured_at)`
  for 3600, 14400, 86400, upserted (last value wins) in the same statement path as each snapshot insert, kept
  forever. 1W/1M/1Y read these; TVL history therefore begins when snapshots began and earlier buckets are
  `null` (the API says so; the UI shows "TVL history starts <date>").
- TVL exists for V4 pools only (launch TVL = its official V4 pool).

### Read-time caching

`ttlMemo` per `(subject, range)` in the API store: 1H 5 s, 1D 15 s, 1W 60 s, 1M/1Y 5 min. Frontend keeps its
per-range cache and the existing gated live refresh.

## Frontend

- `ChartIntervalTabs` becomes `ChartRangeTabs` with labels 1H 1D 1W 1M 1Y; default 1D. URL `?range=`.
  All three chart kinds share the selected range.
- Volume: Lightweight Charts `HistogramSeries`; TVL: `AreaSeries`; both in the project `success` green.
  Bucket `null` ⇒ gap (whitespace point); the readout says "Unavailable" on hover.
- Layout: top-left label ("Volume"/"TVL"), large figure, time below; hover swaps figure and time. Not hovering:
  Volume shows the window total (or "Unavailable" if any bucket is `null`), TVL the latest value.
  USD right axis (compact), ~5 UTC time ticks, faint grid, crosshair.
- Remove the hand-rolled SVG bars (`pool-history-chart.tsx` internals) and the stretched-viewBox approach.
- Pool page: Price + Volume only (no TVL tab), as today.

## Testing

- Unit: range mapping; bucket-derivation math (coarser from finer equals direct computation); null/zero rules.
- PostgreSQL integration: dirty → rollup rebuild; late oracle round un-nulls a bucket; reorg re-dirty; pruning;
  TVL bucket last-value-wins; each read endpoint returns the same numbers as the old raw-trades query on a fixture
  (parity test, then the old query is deleted).
- Measurement before/after on the heaviest local token (1Y volume; 1D price) recorded in the plan; target single-digit ms
  DB time per request.
- FE: component tests for tabs, readout, null gaps. Playwright e2e only if port 3000 is free; otherwise state it was not run.

## Open items for the plan stage

1. Whether the rollup claim shares the existing candle transaction or runs as a separate worker (measure lock contention).
2. Venue-scoped price candles: extend cache with `venue_kind` vs bounded trades path.
3. `usd_candles` redesign (separate work unit).
4. Enabling 60 s snapshots on a live worker is an ops decision; this work only documents it.

## Measurement (2026-10-10, local dev DB, cold cache)

Token `0x39dbed3a…` with 129,173 official trades, `EXPLAIN (ANALYZE)`:

| Read | Before (raw trades + per-trade oracle lookup) | After (rollup range scan) |
|---|---|---|
| 1Y volume (daily buckets) | 8,463 ms | 9 ms |
| 1H volume (1-minute buckets) | not measured (same query shape, ≥ the 1Y cost on a busy token) | 3 ms |

Two design faults were found only by measuring and fixed before this note:
- `launch_volume_buckets` had `venue_kind` ahead of `interval_seconds`/`bucket_start` in its primary key, so range reads and
  rebuilds scanned the whole token. The primary key now ends with `venue_kind` (migration `0051`).
- A plain join of "dirty minutes × trades of the token" made the planner pair every minute with every trade and filter
  (64M rows removed for 500 minutes). The rebuild now aggregates inside a `LATERAL` per minute, which forces one index range scan each.
