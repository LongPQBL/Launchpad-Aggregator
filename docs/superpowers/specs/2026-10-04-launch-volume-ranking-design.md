# Launch list: two tabs with global 24-hour USD volume ranking

Date: 2026-10-04

## Intent and decisions

The owner wants to remove `Trending`. `All` should rank launches across the complete filtered data set by official 24-hour trading volume converted to USD. `Recently launched` should show newest launches first. Both tabs retain the existing search, lifecycle, launchpad, chain, and next-page behavior. The owner chose USD as the common unit because Pons launches use WETH, native ETH, USDG, and stock-token quote assets. The owner confirmed that “official venue” means the already verified venue history of each Pons launch, including executed protocol activity, rather than arbitrary pools for the same token.

Uniswap's Launches UI uses a separate server-side trending ranking, so the previous local `change1h` sort does not meet this product goal. This project will have two tabs only. This change affects the API read path and frontend; new indexing work must use Envio, and this feature does not extend the legacy RPC indexer.

Three approaches were considered. Sorting the fetched page is cheap but gives a false global order. Sorting raw quote amounts across launch assets misranks WETH, USDG, and stock-token pairs. A persistent Envio-maintained volume table is scalable but adds write-path and reorg logic immediately. The chosen path is a measured read-side aggregate with a timestamp index and short-lived price caching, with the Envio-maintained table required if that read path misses the performance gate below.

## Existing behavior and constraints

- `fe/src/features/launches/launch-list.tsx` sorts only the current page for Trending. All and Recently launched both receive the backend's launch-recency order.
- `be/src/api/store.ts` limits the launches query before computing per-row `officialVolume24h`. Sorting those returned rows cannot produce a global rank.
- `officialVolume24h` is in each launch's quote asset, so its decimal amount is not a cross-asset ranking key. The existing Chainlink pricing reader verifies quote-asset feeds by address and rejects stale or invalid prices. It does not provide historical per-trade USD prices.
- The real `trades` table currently has about 3.2 million rows and is about 3.5 GB. Its timestamp index begins with `(chain_id, token_address)`, which does not directly support a global trailing-24-hour scan. Measure the actual plan and latency before accepting a request-time aggregate.
- A launch's `coverageStatus` is determined from its required factory, lifecycle, and official trading sources against the Envio-aware safe head. A missing window must never be presented as genuine zero volume.

## API and ranking behavior

`GET /v1/launches` gains `sort=volume24hUsd|recent`. Keep the API's omitted-sort behavior as `recent` for existing callers; the frontend explicitly requests `volume24hUsd` for All and `recent` for Recently launched. An unknown sort returns 400. Search, status, platform, and chain filters apply before ranking; every page uses the same global order.

For `volume24hUsd`, select indexed trades in `[asOf - 86400, asOf]` for each launch's official venues (`venues.official = true`). Sum raw quote amounts once, using the launch's quote decimals. Include executed protocol buybacks and internal swaps already stored as trades; do not count fee transfers or non-trade events. Reuse the existing per-launch coverage rule when deciding whether the number can be ranked.

Convert positive quote volume with the verified current USD price for its quote-asset address. This follows the API's existing approximate USD treatment of trade values: it estimates 24-hour USD volume at the current quote price, rather than reconstructing each trade's historical USD price. Add `officialVolume24hUsd: string | null` and `officialVolume24hUsdApprox: boolean` to launch summaries, document the approximation in OpenAPI, and show `~$` for converted positive amounts. Keep the existing quote-asset `officialVolume24h` field so detail and other callers retain its units. A known zero-trade window with complete coverage has USD volume `0` even if the quote price is unavailable. A positive quote volume with no verified USD price, or an incomplete window, has USD volume `null`. Never turn either case into zero.

Sort by known USD volume descending, then by the existing launch position descending, then `(chain_id, token_address)` for a total order. Real zero follows positive values; `null` follows known zero. Within the zero and null tails, use launch recency. `recent` keeps newest-first launch position order. A launch can move when new indexed trades, coverage, or a quote price changes; the UI should not claim that the ranking is immutable.

## Cursor and consistency

The volume cursor is distinct from the existing three-field recency/trade cursor. It records a version, sort mode, 24-hour window end (`asOf`), the USD quote-price snapshot used for that page sequence, the last row's rank category/value, and its launch-position tie breakers. It must be signed by the API so a caller cannot forge quote prices or a historical ranking date. Validate sort, numeric values, quote addresses, signature, size, and a bounded cursor age before use. Subsequent pages use the same window and quote prices, so clock movement and oracle changes alone do not reorder the sequence. A cursor for one sort cannot be used with another sort. Existing `recent` and trade cursors retain their current format. Newly indexed historical trades or a reorg can still change rankings during an open pagination sequence; this limitation is explicit and tested where practical.

## Query and performance approach

Start with a read-side query over the authoritative `trades` and `venues` tables, then benchmark it against a representative local copy of the current database. Add a timestamp-leading index for the 24-hour scan if the measured plan needs it. Because the live table is multi-GB, create that index concurrently in the deployment procedure; do not put a blocking index build in the normal transactional migration path. Reuse verified quote prices per distinct quote asset, with the existing short-lived price cache. Avoid a per-launch RPC call or a per-launch trades query across the 160K+ launch set. A missing feed gives that quote asset a null ranking; a temporary feed/RPC failure is observable and retryable on the next request, never persisted as a null score.

The implementation is accepted only if the first and subsequent filtered pages complete comfortably within the frontend's eight-second API timeout on representative data, and repeated requests do not overload the DB. If a request-time aggregate cannot satisfy that gate, use an Envio-fed rolling volume summary and reorg-aware recomputation before shipping this ranking. No writes are added to the legacy indexer.

## Frontend behavior

- Show exactly `All` and `Recently launched`; remove the Trending client-side sorter and its tests.
- The default All route requests USD-volume sort. Recently launched requests recency sort. A stale `?tab=trending` link resolves to All and does not keep a hidden Trending state.
- Preserve tab, filters, and sort on next-page links and search submissions; changing tab or filter starts at page one.
- The 24H volume cell shows approximate USD when available and keeps the quote amount accessible (for example, in a title or secondary text). When USD volume is null, show the existing honest unavailable state rather than a fabricated rank or zero. Explain the approximation and unknown-price cases in the UI without implying the quote price came from the token's launch time.

## Verification

Write failing tests before implementation for: cross-quote USD order; known zero versus null; incomplete coverage; official-venue-only volume; positive volume with missing/stale price; stable tie order and cursor traversal; cursor tampering/expiry/sort mismatch; all filters; preservation of the `recent` order and trade cursor; frontend tab and request wiring. Verify the generated OpenAPI/client types and run backend unit and integration suites, frontend tests, lint, typecheck, and build. Measure and record the query plan/latency on representative data. No live migration or deployment is part of writing the code.

## Out of scope

No Trending score, non-official pool discovery, historical USD pricing per trade, wallet/trading controls, indexer rewrite, or live deployment. The other minor issues from the owner's list remain separate tasks.
