# Plan: price Pons V2 bonding-curve trades

## Spec (inline — no separate spec doc; verified against live chain data this session)

CurveBuy/CurveSell/BuybackLocked trades always have `price_numerator_raw`/`price_denominator_raw`
NULL, in production too (documented gap, not a regression: `docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase2.md`
says this needs "the curve's initial reserves at launch — a value nothing in the current codebase
sources"). That value is now sourced: `totalSupply()` (constant forever, needs no archive RPC) plus
a quote reserve of 0 — both verified live this session against two real launches (one active, one
graduated) via `realQuoteReserve()` and `balanceOf(curve)`, matching TVL and matching the cumulative
buy/sell token deltas already indexed, to the raw unit.

`be/src/launchpads/pons/v2/curve.ts` already has the pure replay math
(`replayCurveEvent`/`rewindCurveEvent`/`replayCurveBuyback`/`rewindCurveBuyback`), written for this
exact purpose, never wired to a caller. The app's `trades` table does not store `fee_raw`/`tax_raw`
for curve trades (only gross `quote_amount_raw`); those exist only in Envio's raw tables
(`envio."RawCurveTrade"."feeRaw"/"taxRaw"`; `RawCurveBuyback` has none, matching `replayCurveBuyback`'s
simpler signature) — the worker reads them from there, not from the app DB.

## Global Constraints

- Additive migration only. Null stays null when genuinely unknown (no fabrication).
- No RPC call inside the main ingestion transaction (`applyV2Curve`/`applyV2Buyback` stay as-is) —
  this is a separate, async, resumable worker, matching `metadataEnrichment`/`priceEnrichment`.
- Reorg-safe: a repaired/replaced window invalidates the per-launch checkpoint (delete it); the next
  tick re-derives it from `totalSupply()` + a full replay of that launch's current trades — safe
  because it's idempotent, not because it's cheap to skip.
- Per-launch processing is one transaction: trade price updates and the checkpoint advance commit
  together, so a crash mid-worker never leaves the checkpoint ahead of what was actually written.

## Task 1: `launch_curve_reserves` checkpoint table

Migration: `chain_id, token_address` PK, `quote_reserve_raw numeric(78,0)`, `token_reserve_raw numeric(78,0)`,
`last_block_number bigint`, `last_log_index integer`, `updated_at timestamptz`.

## Task 2: `be/src/market/curvePricing.ts`

- `applyCurvePricingOnce(pool, envioPool, rpcClient, limit, now)`: finds up to `limit` launches with
  v2-curve official venues whose curve-type trades aren't fully priced yet (checkpoint missing, or
  behind the launch's latest curve trade), replays the due trades in `(block_number, log_index)`
  order from the checkpoint (or from `{quote:0, token:totalSupply}` if the checkpoint is missing),
  writes `price_numerator_raw`/`price_denominator_raw`, advances the checkpoint. Per-launch try/catch
  so one bad launch doesn't block the batch.

## Task 3: reorg invalidation

`invalidateCurveReserve(tx, changedKeys)` — delete the checkpoint row for each changed launch. Call
it from `repairEnvioWindow` (`incrementalRepair.ts`) alongside the existing `invalidateLaunchVolume`.

## Task 4: CLI worker + wiring

`be/src/cli/runCurvePricingWorker.ts` (loop, same shape as `runLaunchStatsWorker.ts`) + npm script
`curve-pricing:worker`. Add to `scripts/mode.sh`'s test-mode worker list.

## Task 5: verify on staging

Confirm against the two already-verified real launches from this session: the active one's latest
price should match `realQuoteReserve()/balanceOf(curve)` read live; FDV should stop being null for
caught-up launches with priced curve trades.
