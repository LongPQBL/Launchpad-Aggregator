# Pool page: Liquidity and Depth charts

Date: 2026-10-12. Status: draft for review.

## Intent

The pool page gets two more chart tabs, as on Uniswap's pool page (Price, Volume, **Liquidity**, **Depth**). Both show the pool's
**current state** with price on the horizontal axis, so they have no time-range tabs. They are for V3 and V4 pools; V2 has no ticks
and does not show them.

Decided with the user (2026-10-12): read the data from the chain when the tab is opened (no new Envio indexing, no history), scope V3/V4,
keep the project's green accent and dotted-grid chart style, `null`/unavailable instead of guessing.

## What Uniswap shows (observed on the ETH/USDC 0.05% V3 pool)

- **Liquidity:** bars of liquidity per price range, the active range in a different color, a header with the current price in both
  directions ("1 ETH = 2,538 USDC / 1 USDC = 0.0003941 ETH") and "Active tick range".
- **Depth:** an order-book view of the same liquidity. A V-shaped chart (green area to the left of the current price, red area to the right,
  price on the axis, zoom in / fit / zoom out buttons) and a table beside it: asks (red) above, a "Spread 0.10% (Fee tier 0.05%)" row, bids (green) below, with
  columns Price (quote), Amount (base), Total (quote value of that row).

## Data source

Read on demand, cached about 60 s per pool.

- **V3:** `slot0` (tick, sqrt price), `tickSpacing`, `liquidity`, then `tickBitmap(word)` for every word of the tick domain and `ticks(tick)` for every
  initialized tick (`liquidityNet`). Measured on a real Pons V1 pool: about 1.5 s for the whole domain (36 words, 2 initialized ticks).
- **V4:** `PoolManager.extsload` using the `StateLibrary` slot layout (pool state mapping slot 6; `slot0` at the state slot, `liquidity` at +3, `ticks` mapping at +4,
  `tickBitmap` at +5). Reading `slot0` and `liquidity` of a real pool this way was verified; reading ticks uses the same technique and must be verified
  in the first task against `getPoolTVL`'s `activeLiquidity` / `tick`.
- Reads are pinned to one block (`blockNumber` returned), batched, with bounded concurrency. A failed or inconsistent read makes the whole answer
  unavailable, never partial.
- A V4 pool whose hook has custom accounting does not follow tick liquidity, so it answers `unavailableReason: 'custom_accounting'` (same rule as the TVL lens).

## Math

- `price(token1 per token0) = 1.0001^tick * 10^(decimals0 - decimals1)`; the chart can be flipped (token order) like the price chart.
- Initialized ticks sorted ascending `t_0 < t_1 < ...`; liquidity inside `[t_i, t_{i+1})` is `sum_{j<=i} liquidityNet_j`. The range containing the current tick must equal the pool's
  reported `liquidity` (check; mismatch makes the answer unavailable).
- Amounts in a range above the current price: `amount0 = L * (1/sqrtPa - 1/sqrtPb)`; below: `amount1 = L * (sqrtPb - sqrtPa)`; the active range is split at the current price.
- Depth rows step by the pool's tick spacing (grouped so each side has at most 40 rows): `Amount` = token0 available in the step, `Total` = its value in token1;
  the chart plots the cumulative token1 value going away from the current price. Spread = the distance between the best ask and best bid, shown with the fee tier.
- Big integers (`liquidity`, `sqrtPriceX96`) are strings over the API and computed with bigint on the server; the response carries display-ready decimals.

## API

`GET /v1/pools/:chainId/:protocol/:poolId/liquidity` (V3 and V4; 404 for V2 or an unknown pool):

```
{ protocol, blockNumber, tickSpacing, currentTick, price, activeLiquidity,
  token0: { address, decimals, symbol }, token1: { ... },
  ranges: [{ tickLower, tickUpper, priceLower, priceUpper, liquidity, active }],
  depth: { asks: [{ price, amount0, total1, cumulative1 }], bids: [...], spreadPercent },
  complete: boolean, unavailableReason: string | null }
```

An empty pool answers `ranges: []` with `complete: true` (a real "no liquidity"), distinct from `unavailableReason` (could not read).
Regenerate `be/openapi.json` and `fe/src/api/schema.ts`.

## Frontend

- The new tabs join the existing switcher under the chart (the pill row with Price, Volume, ...): Price, Volume, **Liquidity**, **Depth** for V3/V4 pools. V2 keeps Price and Volume. Not a separate tab bar above the chart as on Uniswap (decided 2026-10-12).
- The controls row under the chart adapts to the active tab. Range tabs (1H ... All) show only for tabs that use a time range (Price, Volume); the line / candle switch shows only for Price.
  Liquidity and Depth show neither, so the row holds only the tab switcher. Each tab declares what it uses (`usesRange`, `usesChartStyle`) in one place instead of the panel testing tab names.
- Liquidity and Depth load when first opened.
- `pool-liquidity-chart.tsx`: histogram of liquidity per range (green; the active range brighter), dotted grid, current-price marker, header with the price in both directions, hover shows the range's prices and liquidity.
- `pool-depth-chart.tsx` + `pool-depth-table.tsx`: the V-shaped cumulative chart (green bids, red asks as on Uniswap, since buy/sell colors are semantic) with zoom in / fit / zoom out, and the order-book table.
- Loading, error and "unavailable" states in English; never a silent empty chart.

## Out of scope

History of liquidity over time, V2 pools, adding/removing liquidity, per-position data, Explore-page charts.

## Testing

- Unit: tick math (price, range liquidity, amounts per range, depth rows, spread) with known values; V3/V4 read parsing with a fake client; unavailable paths.
- Integration/live: compare the active-range liquidity against the pool's `liquidity()` on a real V3 pool and against `getPoolTVL.activeLiquidity` on a real V4 pool.
- UI: unit tests for the components; then open the real pool page on the dev app (a Pons V1 V3 pool and a V4 pool) and a mock page in Chrome and check every state.

## Risks

- RPC cost per open (about 36 reads for a V3 pool with spacing 200; more for spacing 1 or 10). Mitigation: the cache, bounded concurrency, a cap on words read, and `complete: false` if the cap is hit.
- The V4 slot layout is a protocol detail; the first task verifies it on this chain before anything builds on it.
- Pons pools have very few initialized ticks, so their Liquidity chart is a single wide bar; that is real, not a bug.
