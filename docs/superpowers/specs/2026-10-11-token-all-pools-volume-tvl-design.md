# Token page Volume / TVL charts over all pools

Date: 2026-10-11. Status: draft for review.

## Intent

The token (launch) page charts Volume and TVL for **every pool that holds the token**, like Uniswap's token page.
Today they cover only the launch's official venue: Volume sums official trades (curve + official V4/V3 pool), and TVL reads
the official V4 pool only (`be/src/market/launchHistory.ts`). That disagrees with the Transactions tab, which already merges
official trades with swaps of every other pool of the token.

Decided with the user (2026-10-11):
- The token page shows **All pools only**, with no Official/All toggle. The official venue's own Volume/TVL is read on its own
  pool page, which the Pools tab lists first.
- Price is unchanged (official venue candles).
- Not in scope: the 52-week/Stats header, retention beyond `POOL_TVL_SNAPSHOT_RETENTION_HOURS`, the home list's official 24h volume.

## Volume

`volume(bucket) = official launch volume + volume of every other verified pool holding the token`

- Official part: unchanged, `launch_volume_buckets` (curve and official pool trades).
- Other pools: `pool_volume_buckets` rows of verified `pool_catalog` pools with the token as `currency0`/`currency1`, **excluding
  any pool that is an official venue** (same exclusion `listTransactions` uses) so a swap is counted once.
- Each pool uses the same priced side the pool page uses (currency1, then currency0, first with a verified USD feed and known decimals).
- A pool with no priced side cannot be valued: it is not guessed. The answer is marked `complete: false` and reports how many pools were left out.
- A bucket is `null` (never `$0`) when any included component is unpriced for it. A quiet bucket is a real `0` only when every included pool is caught up
  and the rollups are backfilled.
- Computed at read time by summing per-pool buckets (a token has tens of pools, not thousands). Measure on the heaviest dev token; add a token-level rollup only if it is slow.

## TVL

`tvl(bucket) = sum over pools holding the token of that pool's last snapshot in the bucket`

- Pools: official V4 pool, other V4, V3 and V2 pools of the token. The bonding curve is not a pool. It has a current reserve (`realQuoteReserve`, used for the token's current `tvlUsd`) but no history, so the TVL chart excludes it and is labeled "all pools". The curve page gets no TVL chart or TVL figure (decided 2026-10-11; pump.fun also shows liquidity only as a single number, not a chart). A token that only has its curve therefore has an empty TVL chart while its current TVL figure still shows; the UI says so.
- V3/V2 have no TVL history today (`pool_tvl_snapshots`/`pool_tvl_buckets` are V4-only by CHECK constraint). Add them:
  - Migration relaxes the protocol CHECK on both tables to V4/V3/V2 (additive).
  - The snapshot worker also captures V3 (token balances held by the pool contract plus `slot0` price) and V2 (`getReserves`, price from reserves), valued with the pool's verified quote feed through the existing `calculateTvlUsd`. Each snapshot records its basis (V3 balances include uncollected fees, which is stated in the API).
- A bucket where a pool that already existed has no snapshot makes that bucket `null` (not carried forward, not summed partially). A pool created after the bucket is not counted.
- The history answer reports `complete: false` while any holding pool is not being snapshotted (for example no priced side).

## API and UI

- `GET /v1/launches/:chainId/:token/history` keeps its shape; the numbers now mean all pools. New optional fields: `poolCount`, `unvaluedPools`.
  The `venue=curve` scope (curve page) is unchanged.
- The chart tabs read "Volume · all pools" and "TVL · all pools". The curve page keeps plain "Volume".
- Regenerate `be/openapi.json` and `fe/src/api/schema.ts` with the existing scripts.

## Testing

- Integration: token with an official V4 pool plus a V3 and a V2 pool; volume equals official plus the others, the official pool is not counted twice.
- Integration: an unpriced pool makes the answer incomplete and the bucket `null`; a caught-up quiet bucket is `0`.
- Integration: TVL sums pools per bucket; a missing snapshot gives `null`; a later-created pool is excluded from earlier buckets.
- Unit: V3/V2 snapshot valuation; frontend labels; `tsc`, lint, Playwright desktop and mobile.

## Risks

- TVL history for 1M/1Y stays mostly empty because of the 168 h retention. Raising retention or coarsening old snapshots is a separate storage decision.
- Starting the V3/V2 snapshot worker adds RPC calls per cycle; measure before shortening the interval.
