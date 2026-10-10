# Bonding-curve venue page (design)

Date: 2026-10-10. Status: written for review.

## Goal

Give a Pons launch's bonding curve its own page, shaped like the existing pool detail page, so the
"Bonding curve · Official Pons pool" row at the top of the Pools tab is a real link instead of a
dead row.

The launch page already shows the curve's data, but it merges the curve's history with the V4 pool's
into one chart and one trade list. The curve page is the curve **alone**: its own price chart, volume,
stats and transactions, stopping at graduation. That is the value it adds; a page that only repeated
the launch page would not be worth building.

## Decisions already made with the user

- The page is scoped to the curve venue only (not "same as the launch page, one more link").
- Route: `/launches/<chainId>/<token>/curve`.
- No TVL chart on this page. The pool detail page no longer has one either (removed 2026-10-10).
- Chart tabs: Price and Volume only.
- Backend approach A: add an optional venue filter to the launch endpoints that already exist; do not
  build a parallel `/curve/*` endpoint family.

## Non-goals

- A TVL chart, TVL history, or any per-day reserve series (no archive-state history exists; see
  CLAUDE.md "archive-state curve price reconstruction").
- 24H fees, unless a verified curve fee rate is found during implementation. If it cannot be derived
  from indexed data, the stat is omitted (never shown as 0 or guessed).
- USD-denominated candles for the curve page. Quote-currency only; the currency toggle is hidden like
  on the pool page.
- Any change to the launch page, to V3/V4 pool pages, or to how other launchpads are modelled.

## Backend

### Venue filter

Add an optional `venue` query parameter (value `curve`) to:

| Endpoint | Change |
| --- | --- |
| `GET /v1/launches/:chainId/:tokenAddress/trades` | add `AND v.kind = 'curve'` to the trades query |
| `GET /v1/launches/:chainId/:tokenAddress/transactions` | restrict to the official-trades branch with `v.kind = 'curve'`; the other-pools branch is dropped (it is not curve data) |
| `GET /v1/launches/:chainId/:tokenAddress/history` | `readLaunchHistory` gets an optional venue kind and adds it to its `venues` join |
| `GET /v1/launches/:chainId/:tokenAddress/candles` | see below |

Absent parameter: behaviour is unchanged. Any other value: `400 Invalid venue`.

### Candles

`listCandles` has a fast path over the pre-aggregated `candles` table, which is keyed by
`(chain_id, token_address, interval_seconds)` with no venue dimension. A curve-scoped request must not
read it. With `venue=curve` the handler always takes the existing read-time path (the bounded
500-bucket query over `trades`) with `v.kind = 'curve'` added, and skips the cache. Curve trades are a
small, bounded set, so this is cheap. No new column or backfill.

Completeness rules stay as they are: a bucket with an unpriced trade is omitted and `complete` is
false; no candles are invented across no-trade gaps.

### Curve summary

New small read: `GET /v1/launches/:chainId/:tokenAddress/curve`, returning the data the Stats panel
needs that the existing endpoints do not give for the curve alone:

- `venueId`, `curveAddress` (the venue `ref`), `active` (`effectiveToBlock === null`), `graduatedAtTimestamp`
  (or null),
- `volume24hQuote` — quote-asset volume over the last 24h on the curve venue only (quote units, not USD: the
  existing USD valuation is launch-wide and per-trade, and curve-only USD volume was not needed for the page),
- `tradeCount24h`,
- `lastPrice` of the curve venue.

`404` when the launch has no curve venue (non-Pons launches, or a launch whose venue list has none).
TVL is not part of this response and is not shown on the page (decided with the user: no TVL chart, and the
stat was dropped with it).

### OpenAPI / types

Regenerate `be/openapi.json` and `fe/src/api/schema.ts` with the existing `openapi:write` /
`generate:schema` scripts. Do not hand-edit the generated file.

## Frontend

### Route and navigation

- New route `fe/src/app/launches/[chainId]/[tokenAddress]/curve/page.tsx`, plus a `loading.tsx` that
  uses the shared detail-page skeleton.
- The pinned curve row in `PoolList` (`fe/src/features/pools/pool-list.tsx`) becomes a link to this
  route, like every other row. It keeps "Bonding curve · Official Pons pool" as its caption and still
  shows `—` in the metric columns it has no data for.
- Breadcrumb: `Pools › SYMBOL / QUOTE`, reusing `ChevronRight`.

### Page content

Built from the pool page's pieces, in the same 680 / 360 two-column layout:

- **Header:** pair logo, `SYMBOL / QUOTE`, a "Bonding curve" badge and the caption "Official Pons pool".
- **Chart (left):** price chart (curve-scoped candles) with Price / Volume tabs. Curve-scoped data ends at
  graduation by construction. No graduation marker is drawn: the marker needs the first V4 trade's time, which
  curve-scoped data deliberately does not contain.
- **Transactions (left):** the pool page's transaction list, fed by `venue=curve`.
- **Right column:** Stats card (24H volume in the quote asset, 24H trades, current price, age) and the Swap
  area. There is no TVL stat.
  - Launch still on the curve: the existing curve swap panel.
  - Launch graduated: no swap panel; a short note and a link to the launch's official V4 pool page.

### Empty and partial data

- `null` from the API renders as an em dash / "unavailable"; zero is only shown for a real zero.
- Incomplete coverage shows the same incomplete-data notice the launch page uses.
- A curve with no trades yet shows an empty chart and "No transactions yet", not a spinner.

## Testing

- Backend integration (PostgreSQL): a launch with one curve venue and one V4 venue and trades on both —
  assert that each filtered endpoint returns only curve trades, that the unfiltered response is
  unchanged, that `venue=other` is `400`, that candles under `venue=curve` match a read-time build
  from curve trades only and ignore a deliberately inconsistent cached row, and that the curve
  summary's 24H volume excludes V4 trades and goes `null` on an unpriced trade.
- Backend unit: query parsing for `venue`.
- Frontend unit: the new page renders each state (active curve, graduated curve, no trades, API
  `null`s, 404); the pinned Pools-tab row links to the curve route; the chart panel offers only
  Price and Volume.
- No Playwright run is required for this change; note it as not run, as for earlier work.

## Resolved during implementation

- Curve fee rate: no verified rate is exposed by indexed data, so there is no 24H fees stat.
- Sibling hardening: `ChartTypePanel` gained a `showTvl` prop (default true). The pool page passes false; the launch
  page keeps its TVL tab; a curve-scoped launch chart passes false.

## Open questions

1. Whether a graduated launch's curve page stays reachable from the Pools tab (the pinned row then
   points at the V4 pool). Default: the pinned row is the V4 pool, and the curve page stays reachable
   only by URL and from the V4 pool page's own link back to it, if one is added later.
