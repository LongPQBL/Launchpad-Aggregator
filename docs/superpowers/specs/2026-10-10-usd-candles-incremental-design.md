# Incremental USD candles

Date: 2026-10-10. Status: draft for review. Follow-up to `2026-10-10-chart-ranges-design.md`, which left this out on purpose.

## Problem

The chart's USD price mode (the default for Pons launches) reads `usd_candles`. That table is refreshed by
`refreshUsdCandles` in `be/src/market/usdCandleStore.ts`, called per `(launch, interval)` from
`be/src/cli/runUsdCandleWorker.ts`:

- It **deletes every USD candle of the token for that interval and re-inserts them all**, from every official trade
  since launch, joining each trade to its oracle round with a `LEFT JOIN LATERAL`.
- The worker repeats this for 6 intervals × every launch with a trade in the last 5 minutes (every minute) and in the
  last 3 days (every 15 minutes).
- Cost is proportional to a token's whole trade history, not to the one new trade. A token with 100k trades re-reads
  100k trades × 6 intervals each cycle. The delete and re-insert happen in one transaction, so readers never see a gap,
  but nearly all of the token's rows are rewritten every time.

Not a correctness problem today; a DB-load and scaling problem.

## Goal

USD candles are maintained incrementally, like the quote candles and the volume rollups: one dirty minute changes only
the buckets that contain it. Reads stay a primary-key range scan.

Unchanged rules: price per trade = `usd_value / token_amount` with the oracle round at or before the trade's
`(block, log_index)`, rejected when older than 24 h or from the future; **a bucket with any unpriced trade has no candle**
(a gap, never an invented price); only official-venue trades count; no venue dimension (launch-wide), so the existing
"USD candles are not available per venue" API rule stays.

## Design

New table `launch_usd_candle_buckets(chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, volume_usd, trade_count, unpriced_count)`
with PK `(chain_id, token_address, interval_seconds, bucket_start)` (range-friendly, no venue column). Intervals stored:
60, 300, 3600, 14400, 86400 (the five range buckets; the legacy 900 is not carried over).

Maintenance (same dirty-minute claim as the candle and volume rollups, same transaction):
- 60 s bucket: from that minute's official trades (position-ordered). `open` = first priced price, `close` = last,
  `high`/`low` = max/min, `volume_usd` = sum, `unpriced_count` = trades with no valid price.
- Coarser buckets: from the next finer table. `open` = first child's open, `close` = last child's close, `high`/`low` =
  max/min, sums for volume/trade/unpriced counts. Children are time-disjoint, so first/last by `bucket_start` is exact
  (this is why a venue split could not be used here: open/close need a launch-wide order).
- A bucket is readable only when `unpriced_count = 0` (the reader drops the rest, same as the current HAVING clause).
- Oracle round arriving late: `redirtyVolumeForPriceChange` already re-queues the affected minutes; the same dirty
  claim rebuilds USD candles too, so no new trigger is needed.
- Reorg/late trade: handled by the existing trade triggers (the minute is re-dirtied; coarser buckets rebuild from it).

Read path: `listUsdCandles` reads `launch_usd_candle_buckets` for the requested interval and window instead of
`usd_candles`; `computedAt` is replaced by the bucket's rebuild time or dropped from the response (the FE does not use it).

Cutover (additive, reversible):
1. Add the table and the writers; run a resumable backfill (reuses `backfillLaunchVolume`'s per-launch loop).
2. Compare the new reads with `usd_candles` on real launches (parity script) before switching the reader.
3. Switch the reader; stop `usd-candles:worker`.
4. `usd_candles` and `refreshUsdCandles` are removed only in a later, separate change after a quiet period.

## Retention

Same as the volume rollups: 60 s kept 24 h, 5 m 3 d, 1 h 14 d, 4 h 60 d, 1 d forever (the range tabs need at most
1 h / 1 d / 7 d / 30 d / 365 d of each).

## Testing

- Unit/integration: a minute with priced trades; a minute with an unpriced trade (no candle); coarser bucket equals a direct
  computation over the same trades (open/close/high/low/volume); late oracle round turns a gap into a candle; trade
  deletion removes minute and coarser candles.
- Parity: for N real launches, `launch_usd_candle_buckets` rows equal `usd_candles` rows for the same interval and bucket.
- Measurement: cost of one new trade on a token with >100k trades, before (full rebuild) and after (one minute and its
  containing buckets), recorded in the plan.

## Out of scope

Per-venue USD candles; changing the price-validity rules; pool USD candles (pools have no USD candle series).

## Open items for the plan stage

1. Resolved: `computedAt` is dropped from the USD candle response (the frontend never reads it).
2. Whether to fold this table into `launch_volume_buckets` (it already has USD volume and unpriced counts) by adding
   OHLC columns for a `venue_kind = 'all'` row, versus a separate table (cleaner; chosen here).
