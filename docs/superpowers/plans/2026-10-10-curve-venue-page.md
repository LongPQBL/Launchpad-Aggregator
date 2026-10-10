# Bonding-curve venue page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page at `/launches/<chainId>/<token>/curve` that shows a Pons launch's bonding curve alone (price chart, volume, stats, transactions), linked from the pinned row of the Pools tab.

**Architecture:** The existing launch endpoints (`trades`, `transactions`, `history`, `candles`) gain an optional `venue=curve` filter; a small `GET .../curve` summary endpoint supplies the curve-only 24H figures. The frontend page reuses the launch page's chart panel, transaction list and curve swap panel, scoped to the curve.

**Tech Stack:** Fastify + PostgreSQL (`be/`), Next.js App Router + Vitest (`fe/`), generated OpenAPI types.

**Spec:** `docs/superpowers/specs/2026-10-10-curve-venue-page-design.md`

## Global Constraints

- Absent `venue` parameter: every endpoint behaves exactly as before. Any value other than `curve`: `400 Invalid venue`.
- `null` means unavailable, never 0. A bucket with an unpriced trade is omitted from candles and `complete` is false. No candles invented across no-trade gaps.
- The curve page has no TVL chart and no TVL history. Chart tabs: Price and Volume only (the launch page keeps its TVL tab).
- Quote-currency candles only on the curve page; no currency toggle.
- No 24H fees stat (no verified curve fee rate is available in indexed data).
- The curve venue row has `kind = 'curve'` in `venues` (id `pons-v2-curve:<token>`).
- Frontend copy in English. Generated files (`be/openapi.json`, `fe/src/api/schema.ts`) come from `openapi:write` / `generate:schema`, never by hand.

## Review Focus

- A launch with trades on both the curve and its V4 pool: curve-scoped endpoints must show only curve trades; unscoped must be unchanged (Task 1, 2).
- A cached candle row that disagrees with the trades: `venue=curve` must ignore the cache (Task 2).
- A launch with no curve venue (non-Pons, or V3-only): the summary answers 404 and the page shows not-found (Task 3, 5).
- A graduated launch opened on the curve page: no swap panel, a link to the V4 pool, chart ends at graduation (Task 5).
- A curve with no trades yet: empty chart and "No transactions yet", not a spinner or zeros (Task 5).

---

### Task 1: `venue` filter on trades and transactions

**Files:**
- Modify: `be/src/api/server.ts` (the `ListQuery` interface)
- Modify: `be/src/api/routes/launches.ts` (`listQuery`)
- Modify: `be/src/api/store.ts` (`listTrades`, `listTransactions`)
- Test: `be/src/api/store.integration.test.ts`, `be/src/api/server.test.ts`

**Interfaces:**
- Produces: `ListQuery.venue?: 'curve'`; `listTrades`/`listTransactions` return only curve-venue rows when it is set.

- [ ] **Step 1: Write the failing store test.** Append a `describe('venue=curve scoping', …)` to `store.integration.test.ts` that seeds one launch with a `curve` venue (`pons-v2-curve:<token>`) and a `v4_pool` venue (`pons-v2-v4:<token>`, `effective_from_block` 2), one trade on each (block 1 on the curve, block 2 on the V4 venue), then asserts:

```ts
const all = await store.listTrades(4663, scopedToken, { limit: 10 });
expect(all.items).toHaveLength(2);
const curveOnly = await store.listTrades(4663, scopedToken, { limit: 10, venue: 'curve' });
expect(curveOnly.items.map((item) => item.venueId)).toEqual([`pons-v2-curve:${scopedToken}`]);
const tx = await store.listTransactions(4663, scopedToken, { limit: 10, venue: 'curve' });
expect(tx.items.every((item) => item.source === 'official' && item.venueId === `pons-v2-curve:${scopedToken}`)).toBe(true);
```

  Seed with the same INSERT shapes as `seedOfficialOnly` in the existing `listTransactions` describe (sources, launches, venues, trades); clean up in `afterEach` by token address.

- [ ] **Step 2: Run to verify failure.** `cd be && npx vitest run src/api/store.integration.test.ts -t "venue=curve scoping"` — FAIL (`venue` ignored, 2 items).

- [ ] **Step 3: Implement.** In `server.ts`: `export interface ListQuery { limit: number; cursor?: string; chainId?: number; venue?: 'curve' }`. In `store.ts` `listTrades` add `AND ($7::text IS NULL OR v.kind = $7)` after the `v.official = true` line and `query.venue ?? null` as the 7th parameter. In `listTransactions`'s `official_page` add the same `AND ($7::text IS NULL OR v.kind = $7)`; in `pool_page` add `AND $7::text IS NULL`; append `query.venue ?? null` as the 7th parameter.

- [ ] **Step 4: Run to verify pass.** Same command — PASS; also run the whole file to confirm no regression.

- [ ] **Step 5: Route parsing test.** In `server.test.ts`, near the existing `transactions?limit=0` test, add: `?venue=curve` returns 200 and passes `venue: 'curve'` to the data double's `listTransactions`; `?venue=pool` returns 400 on both `trades` and `transactions`.

- [ ] **Step 6: Implement route parsing.** In `launches.ts` extend `listQuery`'s return type with `venue?: 'curve'`; before returning: `if (value.venue !== undefined && value.venue !== 'curve') return null;` and spread `...(value.venue === 'curve' ? { venue: 'curve' as const } : {})`. Both `trades` and `transactions` handlers already answer 400 when `listQuery` is null.

- [ ] **Step 7: Run and commit.** `cd be && npx vitest run src/api/server.test.ts src/api/store.integration.test.ts && npx tsc --noEmit`, then `git add be/src/api && git commit -m "feat(api): venue=curve filter on launch trades and transactions"`.

### Task 2: `venue` filter on history and candles

**Files:**
- Modify: `be/src/market/launchHistory.ts`, `be/src/api/store.ts` (`listLaunchHistory`, `listCandles`), `be/src/api/server.ts` (data interface), `be/src/api/routes/launches.ts` (`history`, `candles` handlers)
- Test: `be/src/market/launchHistory.integration.test.ts`, `be/src/api/store.integration.test.ts`, `be/src/api/server.test.ts`

**Interfaces:**
- Produces: `readLaunchHistory(pool, { …, venueKind?: string })` (TVL series omitted: every `tvlUsd` is `null` when `venueKind` is set); `listLaunchHistory(chainId, token, { intervalSeconds, buckets, venueKind? })`; `listCandles(chainId, token, intervalSeconds, before?, venueKind?)`.

- [ ] **Step 1: Failing history test** in `launchHistory.integration.test.ts`: seed a launch with a curve trade (10 quote) and a V4 trade (5 quote) in the same day bucket, with a verified feed so both are priced (reuse that file's existing seeding helper). Assert unscoped `volumeUsd` equals the sum and `readLaunchHistory(..., venueKind: 'curve')` equals only the curve trade's USD and every `tvlUsd` is `null`.

- [ ] **Step 2: Run, expect FAIL**, then implement: add `venueKind?: string` to the options type; in the `trade_usd` CTE add `AND ($7::text IS NULL OR v.kind = $7)` to the `JOIN venues v ON … AND v.official = true` line's ON clause and pass `options.venueKind ?? null` as the 7th parameter; wrap the TVL query so that when `options.venueKind` is set it is skipped (`tvl.rows` treated as empty).

- [ ] **Step 3: Failing candles test** in `store.integration.test.ts`: with the same two-venue seed, call `store.listCandles(4663, token, 3600, undefined, 'curve')` and assert the candle's `quoteVolume` counts only the curve trade; also insert a deliberately wrong `candles` row plus `candle_cache_state.backfill_complete = true` and assert the curve-scoped call ignores it while the unscoped call still reads it (restore the state in `afterEach`).

- [ ] **Step 4: Implement.** In `listCandles` add the `venueKind?: string` fifth parameter; guard the cached branch with `if (!venueKind && cacheState.rows[0]?.backfill_complete === true)`; in the read-time query add `AND ($5::text IS NULL OR v.kind = $5)` and pass `venueKind ?? null` as the 5th parameter. Update the `DataSource` signatures in `server.ts` (`listCandles(..., before?: number, venueKind?: string)`, `listLaunchHistory?(…, window: { intervalSeconds: number; buckets: number; venueKind?: string })`) and have `listLaunchHistory` forward `venueKind` to `readLaunchHistory`.

- [ ] **Step 5: Route handling.** In the `history` handler: `const venue = request.query.venue; if (venue !== undefined && venue !== 'curve') return reply.code(400).send({ error: 'Invalid venue' });` and pass `venueKind: venue` in the window. In the `candles` handler: same validation; for `currency === 'usd'` with `venue` set return `400 { error: 'Unsupported' }`; pass `venue` as the last argument of `deps.data.listCandles`. Add server tests for the 400s and for the argument being forwarded.

- [ ] **Step 6: Run and commit.** `cd be && npx vitest run src/market src/api && npx tsc --noEmit`, then commit `feat(api): venue=curve filter on launch history and candles`.

### Task 3: Curve summary endpoint

**Files:**
- Modify: `be/src/api/schemas.ts`, `be/src/api/server.ts`, `be/src/api/store.ts`, `be/src/api/routes/launches.ts`; regenerate `be/openapi.json`
- Test: `be/src/api/store.integration.test.ts`, `be/src/api/server.test.ts`

**Interfaces:**
- Produces: `GET /v1/launches/:chainId/:tokenAddress/curve` → `{ venueId: string; curveAddress: string; active: boolean; volume24hQuote: string; tradeCount24h: number; lastPriceQuote: string | null }`, `404` when the launch has no curve venue. `DataSource.getCurveSummary?(chainId, tokenAddress): Promise<CurveSummary | null>`.

- [ ] **Step 1: Failing store test** (two-venue seed again): `getCurveSummary` returns `venueId` `pons-v2-curve:<token>`, `active` true while `effective_to_block` is null (false once set), `volume24hQuote` counting only trades inside the last 24 hours on the curve venue (seed one trade with `timestamp = now`, one old, one on the V4 venue), `tradeCount24h` 1, and `null` for a launch with no curve venue.

- [ ] **Step 2: Implement `getCurveSummary`** in `store.ts`:

```ts
async getCurveSummary(chainId: number, tokenAddress: string): Promise<CurveSummary | null> {
  const token = tokenAddress.toLowerCase();
  const venue = (await pool.query(`SELECT v.id, v.ref, v.effective_to_block, l.quote_asset_decimals FROM venues v
    JOIN launches l ON l.chain_id = v.chain_id AND l.token_address = v.token_address
    WHERE v.chain_id = $1 AND v.token_address = $2 AND v.kind = 'curve' AND v.official = true LIMIT 1`, [chainId, token])).rows[0] as Row | undefined;
  if (!venue) return null;
  const since = Math.floor(Date.now() / 1000) - 86_400;
  const volume = (await pool.query(`SELECT COALESCE(sum(quote_amount_raw), 0)::text AS raw, count(*)::int AS trades FROM trades
    WHERE venue_id = $1 AND timestamp >= $2`, [string(venue.id), since])).rows[0] as Row;
  const last = (await pool.query(`SELECT price_numerator_raw, price_denominator_raw FROM trades WHERE venue_id = $1
    AND price_numerator_raw IS NOT NULL AND price_denominator_raw IS NOT NULL
    ORDER BY block_number DESC, log_index DESC LIMIT 1`, [string(venue.id)])).rows[0] as Row | undefined;
  return { venueId: string(venue.id), curveAddress: string(venue.ref), active: venue.effective_to_block === null,
    volume24hQuote: formatUnits(BigInt(string(volume.raw)), number(venue.quote_asset_decimals)), tradeCount24h: number(volume.trades),
    lastPriceQuote: last ? formatRational(BigInt(string(last.price_numerator_raw)), BigInt(string(last.price_denominator_raw)), 18) : null };
},
```

  Define `CurveSummary` in `server.ts`, add `getCurveSummary?(…)` to the `data` interface (optional like `listLaunchHistory`).

- [ ] **Step 3: Schema and route.** In `schemas.ts` add `export const curveSummary = { type: 'object', properties: { venueId: { type: 'string' }, curveAddress: { type: 'string' }, active: { type: 'boolean' }, volume24hQuote: { type: 'string' }, tradeCount24h: { type: 'integer' }, lastPriceQuote: { type: ['string', 'null'] } } };`. In `launches.ts` register `GET /v1/launches/:chainId/:tokenAddress/curve` with response schema `curveSummary`: 404 on bad params or null result, 503 when `deps.data.getCurveSummary` is absent. Add `server.test.ts` cases: 200 passthrough, 404 when the double returns null, 503 without the method.

- [ ] **Step 4: Regenerate OpenAPI.** `cd be && npm run openapi:write` (check `package.json` for the exact script name) and confirm `be/openapi.json` gains the new path.

- [ ] **Step 5: Run and commit.** `npx vitest run src/api && npx tsc --noEmit`, then commit `feat(api): curve venue summary endpoint`.

### Task 4: Frontend client and chart plumbing

**Files:**
- Modify: `fe/src/api/client.ts`, `fe/src/api/schema.ts` (regenerated), `fe/src/features/launch/official-chart.tsx` (source type + fetch), `fe/src/features/launch/launch-chart-panel.tsx`, `fe/src/features/launch/official-price-chart.tsx` if it forwards `source`
- Test: `fe/src/api/client.test.ts` (or the existing client test file), `fe/src/features/launch/launch-chart-panel.test.tsx`

**Interfaces:**
- Produces: `getLaunchTransactions/getLaunchTrades/getLaunchCandles/getLaunchHistory(…, { venue?: 'curve' })`; `getCurveSummary(chainId, token): Promise<CurveSummary | null>` (null on 404); `LaunchChartPanel` accepts `venue?: 'curve'` and, when set, renders only Price / Volume (`showTvl={false}`) and loads history/candles with the filter.

- [ ] **Step 1:** `cd fe && npm run generate:schema` (check the script name) so `schema.ts` knows the new query parameter and path.
- [ ] **Step 2: Failing tests.** Client test: `getLaunchTransactions(4663, '0xabc…', { venue: 'curve' })` requests `…/transactions?venue=curve`; without the option the query string has no `venue`; `getCurveSummary` returns `null` on 404 and the parsed body on 200. Panel test: `LaunchChartPanel` with `venue="curve"` and a history has tabs Price and Volume but no TVL tab (the existing test keeps proving the default shows TVL).
- [ ] **Step 3: Implement.** Add `venue?: 'curve'` to `TradeQuery`/`CandleQuery`; thread it into the four request functions' query objects; add `getHistory`'s optional parameter (`getLaunchHistory(chainId, token, intervalSeconds = 86_400, venue?)`); add `getCurveSummary` (404 → null, as `getLaunchDetail` does). Extend `OfficialChartSource.launch` with `venue?: 'curve'` and pass it in `getLaunchCandles(...)` inside `OfficialChart`'s `fetchPage`. `LaunchChartPanel` takes `venue` and passes it to `loadHistory` and `showTvl={venue === undefined}`.
- [ ] **Step 4: Run and commit.** `npx vitest run src/api src/features/launch && npx tsc --noEmit`, commit `feat(fe): venue-scoped launch client calls and chart panel`.

### Task 5: The curve page

**Files:**
- Create: `fe/src/app/launches/[chainId]/[tokenAddress]/curve/page.tsx`, `fe/src/app/launches/[chainId]/[tokenAddress]/curve/loading.tsx`, `fe/src/features/curve/curve-detail.tsx`
- Test: `fe/src/features/curve/curve-detail.test.tsx`

**Interfaces:**
- Consumes: Task 4's client functions and `LaunchChartPanel venue="curve"`; existing `TransactionList`, `CurveSwapPanel`, `PoolLogo`, `ChevronRight`, `detail-page-skeleton`, `StickyDetailHeader`, `Card`.
- Produces: `CurveDetail({ detail, summary, transactions, candles, history, chartInterval })`.

- [ ] **Step 1: Failing component tests** (`curve-detail.test.tsx`), mocking `next/link`-free pieces the same way `launch-detail.test.tsx` does: (a) active curve renders breadcrumb `Pools › SYMBOL / QUOTE`, a "Bonding curve" badge, the chart tabs Price and Volume only, a Stats card with `24H volume` and `24H trades` from `summary`, and the curve swap panel; (b) `summary.active === false` renders no swap panel and a link to the official V4 pool (`/pools/<chainId>/uniswap_v4/<poolId>?displayedToken=<token>`) built from the launch's V4 official venue; (c) empty `transactions.items` renders "No transactions yet"; (d) `summary.lastPriceQuote === null` renders an em dash, not 0.
- [ ] **Step 2: Implement `curve-detail.tsx`** in the shape of `pool-detail.tsx`: breadcrumb with `ChevronRight`, `StickyDetailHeader` card (PoolLogo `detail` size + title + badge + caption "Official Pons pool"), a `grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-[7.143%]` layout. Left column: `<LaunchChartPanel venue="curve" … showCurrencyToggle={false} />` (quote currency; pass the launch's `chainId`, `tokenAddress`, `candles`, `history`, `intervalSeconds`, `quoteSymbol`, `tokenSymbol`, `coverageStatus`, `graduationTime`) then a Transactions section using `TransactionList` with `venue` forwarded for its load-more calls. Right column: Stats (`24H volume` `{summary.volume24hQuote} {quote}`, `24H trades`, `Age` from `detail.launchTimestamp`, `Current price` from `summary.lastPriceQuote`), then the curve swap panel from `launch-detail.tsx` (same props, only when `summary.active`), else the graduated note and V4 link.
- [ ] **Step 3: `page.tsx`.** Server component: parse params as in the launch page, `getLaunchDetail`; `notFound()` when null or when `getCurveSummary` is null; fetch `getLaunchTransactions(…, { venue: 'curve' })`, `getLaunchCandles(…, { venue: 'curve', currency: 'quote', intervalSeconds })`, `getLaunchHistory(…, 86_400, 'curve')` with `.catch(() => null)`; render `LiveRefreshIndicator` (launch key) and `CurveDetail`. `loading.tsx` renders the shared detail-page skeleton like the launch page's.
- [ ] **Step 4: Run and commit.** `npx vitest run src/features/curve && npx tsc --noEmit && npx next build`, commit `feat(fe): bonding-curve venue page`.

### Task 6: Link the Pools-tab row, update spec, verify, push

**Files:**
- Modify: `fe/src/features/pools/pool-list.tsx` (pinned curve row), `fe/src/features/pools/pools.test.tsx`, `docs/superpowers/specs/2026-10-10-curve-venue-page-design.md`

- [ ] **Step 1: Failing test:** the pinned curve row (`primaryVenue.kind === 'curve'`) is an element with role `link` whose `href` is `/launches/<chainId>/<token>/curve`, and still shows "Bonding curve · Official Pons pool".
- [ ] **Step 2: Implement:** give the curve row the same absolute-inset `Link` the pool rows use (`aria-label="View bonding curve SYMBOL / QUOTE"`, `href={`/launches/${curveRow.chainId}/${curveRow.token.address}/curve`}`), make the row `cursor-pointer`. `PoolListDisplayedToken` must carry `address` (it already does for `displayedToken`).
- [ ] **Step 3: Update the spec** to match what was built: the summary endpoint returns `volume24hQuote` (quote units) rather than USD volume, there is no 24H fees stat, and the page shows an approximate USD only if the launch's `quotePriceUsd` is known.
- [ ] **Step 4: Final verification:** `cd be && npx tsc --noEmit && npx vitest run`; `cd fe && npx tsc --noEmit && npx vitest run && npx next build`; report any failures that predate this work separately.
- [ ] **Step 5: Commit and push** only the files this plan touched (`git add` explicit paths), commit `feat: link the Pools-tab curve row to its page`, check `git remote -v` and the branch, then `git push origin main`.
