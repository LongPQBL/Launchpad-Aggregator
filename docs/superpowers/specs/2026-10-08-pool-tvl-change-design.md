# Pool TVL "vs 24h ago" change

## Goal

Show `▼/▲ %` next to **TVL** on the pool detail page (like Uniswap), comparing current TVL with TVL 24h ago. The 24H-volume equivalent already shipped (`volume24hChange`). Unavailable data renders as "—", never 0%.

## Why a new table

TVL is read live from chain at the current block (`readPoolSnapshot` in `be/src/pools/stats.ts`, V4 only, via `getPoolTVL`). No history is stored, Envio only indexes swaps (not liquidity events), and the RPC provider rejects historical `eth_call`. So the only honest way to get "TVL 24h ago" is to record snapshots going forward.

## Understanding (confirmed with user 2026-10-08)

- Compare against the snapshot nearest to `now − 24h`; TVL 24h ago is the **USD value recorded at capture time** (percent includes quote-price movement, like Uniswap). Raw amounts are stored too so it can be recomputed later.
- First 24h after the worker starts: change is "—". Expected, not a bug.
- V4 pools only (the only protocol with a TVL today). V3/V2 stay without TVL.

## Design

### Table `pool_tvl_snapshots` (additive migration)

| column | notes |
|---|---|
| `chain_id`, `protocol`, `pool_id` | FK-like key to `pool_catalog` |
| `captured_at` (timestamptz), `block_number` (bigint) | PK = (`chain_id`,`protocol`,`pool_id`,`block_number`) |
| `core_amount0_raw`, `core_amount1_raw` (numeric) | from `getPoolTVL` |
| `sqrt_price_x96` (numeric) | from `getPoolTVL` |
| `quote_address` (text) | the currency whose verified USD feed priced this row |
| `tvl_usd` (numeric) | `calculateTvlUsd` output at capture time |

Rows are written only for a successful, valid lens read for a pool with a verified-feed quote side (`hasCustomAccounting === false`, amounts ≥ 0, sqrt price > 0 — same validation as `readPoolSnapshot`). A failed or invalid read writes **nothing**.

### Worker `be/src/cli/runPoolTvlSnapshotWorker.ts`

Same shape as `runPoolCandleWorker.ts` (own `pg` Pool, SIGINT/SIGTERM, per-iteration try/catch). Every `POOL_TVL_SNAPSHOT_INTERVAL_SECONDS` (default 3600), for each `verified` `uniswap_v4` pool in `pool_catalog`: read lens at the current block, pick the quote side (the currency with a verified feed; if both have one, prefer the lower address for determinism), value it with the current USD price, insert. One pool's failure must not stop the others. Core logic lives in `be/src/pools/tvlSnapshots.ts` (`captureTvlSnapshot`, `readTvlChange`) so it is testable without the loop. Reuses `RESERVES_LENS`/`lensAbi` by exporting them from `stats.ts` instead of duplicating.

### Retention

The change only needs a snapshot near `now − 24h` (±2h), so older rows are useless. After each capture pass the worker deletes rows with `captured_at < now − POOL_TVL_SNAPSHOT_RETENTION_HOURS` (default 168 = 7 days; must be > 26h or the worker refuses to start, so a misconfiguration can never delete the row the read path needs). This also bounds the table at ≈ 168 rows per pool. The delete is a single `DELETE … WHERE captured_at < $1`, backed by an index on `captured_at`. It runs even if every capture in the pass failed, so a prolonged RPC outage still doesn't grow the table (it just leaves no recent rows, and the change shows "—").

### Read path

`readPoolStats` gains `tvlChange: string | null`:

1. Find the snapshot with `captured_at` closest to `asOf − 86_400`, within ±2h of that mark (`captured_at BETWEEN … `).
2. Require its `quote_address` to equal the quote side used for the current `tvlUsd`, and both `tvl_usd` values > 0.
3. `tvlChange = (current − previous) / previous × 100`; otherwise `null`.

Added to `poolSummary` in `be/src/api/schemas.ts`; regenerate `be/openapi.json` and `fe/src/api/schema.ts` via `openapi:write` / `generate:schema`.

### Frontend

`PoolStats` (`fe/src/features/pools/pool-stats.tsx`) renders `<PercentChange value={tvlChange} />` beside TVL, same markup as the volume change (`data-testid="tvl-change"`).

## Testing

- Unit: change calculation (zero/negative previous → `null`).
- Integration (PostgreSQL): pruning deletes only rows older than the retention window and keeps the ~24h-old row; the worker rejects a retention shorter than 26h. `readTvlChange` picks the nearest snapshot within the window; returns `null` when none within ±2h, when quote address differs, or when previous TVL is 0. `captureTvlSnapshot` writes nothing on an invalid lens result.
- FE: `PoolDetail` shows `▼ 12.00%` for a negative change and "—" for `null`.

## Out of scope

V3/V2 TVL, backfilling history, TVL chart over time, launch-detail-page TVL change.

## Operations note

The worker must be started alongside the API (new npm script `dev:pool-tvl-snapshots`). Nothing is deployed or run against a live DB by this change.
