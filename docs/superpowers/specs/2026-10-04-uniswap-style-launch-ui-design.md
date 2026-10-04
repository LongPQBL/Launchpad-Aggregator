# Uniswap-Style Launch List/Detail UI Design

## Goal

Redesign the FE launch list table and launch detail page to match Uniswap's
Launches UI layout (columns, filters, About section), while keeping this
project's own light/blue theme — not Uniswap's dark palette. Close the data
gaps this redesign exposes: token logo, description, website, Twitter link,
and 1H/1D price-change percentages, none of which exist in the current data
model.

## Background

The user supplied two reference screenshots of `app.uniswap.org`'s launches
page: a list table (columns `#`, `Token` with a chain-badge overlay on the
logo, `Launchpad`, `FDV`, `24H volume`, `Liquidity`, `1H %`, `1D %`, `Age`,
plus tabs `All`/`Recently launched`/`Trending` and `Launchpad`/chain filter
dropdowns) and a detail-page "About" section (description with "Show more",
and pill buttons for the token address, a block-explorer link, Website, and
Twitter).

The current FE list table (`fe/src/features/launches/launch-list.tsx`) has
no logos, no launchpad/chain filter dropdowns, no 1H/1D change columns, and
no About section on the detail page. `FDV`, `24H volume`, and `Liquidity`
(TVL) already exist in the API from the earlier Uniswap-parity-stats and
Pons-TVL-correction work.

Four things needed research before design could proceed; all were resolved
by verifying against real data, not by trusting documentation alone:

1. **Token metadata (logo/description/socials).** Pons has no public API —
   confirmed via their own docs: "integrators are told to index the factory
   and the curves themselves." Their docs instead describe three on-chain
   functions on every launched token contract: `logo()`, `description()`,
   `socials()` (returning `{twitter, telegram, discord, website, farcaster}`).
   Verified live against two real Pons tokens already in the `launchpad` DB
   (`0xadd59906...` and `0x2c4271a1...`): `logo()` returned a real
   `ipfs://bafkrei...` URI, `description()` returned real text on one token
   and an empty string on the other (not every creator fills it in),
   `socials()` returned the documented 5-tuple with only `twitter` populated
   on both samples.
2. **Block explorer.** Confirmed via search (flagging that `hoodexplorer.org`
   is a known non-official/phishing lookalike): the real Robinhood Chain
   explorer is Blockscout at `robinhoodchain.blockscout.com`. Verified the
   token page pattern `https://robinhoodchain.blockscout.com/token/{address}`
   is live and real against one of the same sample tokens.
3. **IPFS gateway for rendering `logo()`'s `ipfs://` URI as an `<img>`.**
   Tested three public gateways against the real sample hash:
   `ipfs.io` returned 429 (rate-limited), `cloudflare-ipfs.com` failed DNS
   resolution entirely (the domain has been retired), `gateway.pinata.cloud`
   returned 200 with the correct `image/jpeg` content-type and real image
   bytes. Pinata's public gateway is the only one of the three that is
   currently real and working.
4. **1H/1D price-change feasibility.** No new data source needed — the same
   official-trade price history already used for the existing 52-week
   high/low computation (`compute52WeekHighLow` in `be/src/market/aggregate.ts`)
   is sufficient; this is a new computation over existing data, not a new
   ingestion path.
5. **"Age" column feasibility.** Checked `be/src/db/schema.ts`'s `launches`
   and `observed_blocks` tables: neither stores a block timestamp, only the
   block *number*. There is currently no way to render "80d" honestly from
   existing data — approximating age from an average block-time constant
   would look exact while actually being a fabricated estimate, which this
   project's null-means-unavailable discipline rules out. This needs one
   more new column (see Data model changes below), not just a UI change.

## Decisions (confirmed with the user)

- **Theme:** keep the existing light/blue theme. Only the column layout,
  filters, and About-section structure are borrowed from Uniswap — not its
  dark palette.
- **Chain filter:** cosmetic only. Show the chain logo next to the token logo
  (as a badge) and in a filter-style dropdown, but the dropdown has exactly
  one option (Robinhood Chain) today. No multi-chain filtering infrastructure
  is being built in this pass — CLAUDE.md's existing one-chain scope stands.
- **Launchpad filter:** a real dropdown, populated from the existing
  `/v1/sources` data (already platform-aware), even though it currently
  resolves to one option (Pons). This reuses existing data, so it costs
  nothing to make it a real (if currently trivial) filter.
- **Historical launches (166K+ already indexed):** do **not** backfill their
  metadata in this plan. New launches get `logo`/`description`/`socials`
  automatically going forward through the existing per-launch metadata-read
  call site. Existing launches show no logo/description/links (honestly
  absent, not a fabricated placeholder) until a separate, explicitly-scoped
  backfill job is planned later — backfilling all 166K would mean roughly
  500K additional RPC calls, which is its own cost/rate-limit decision the
  user has not made.
- **"Trending" tab:** sorts by `1H %` descending. No new ranking algorithm —
  reuses the same data the `1H %` column shows.

## Data model changes

### `launches` table (additive columns, nullable)

- `logo_uri text` — raw `ipfs://...` (or whatever URI scheme the contract
  returns) exactly as read from `logo()`. Gateway resolution happens at the
  FE layer, not at write time, so changing gateways never requires
  re-indexing.
- `description text`
- `website_url text`
- `twitter_url text`

- `launch_timestamp integer` (unix seconds) — read via `eth_getBlockByNumber(launchBlock)` at the
  same one-time sync call site, not approximated from an average block-time
  constant. Needed for the `Age` column (see Background's open-question #5).
  Nullable in principle (an RPC failure must not block indexing the launch
  itself), though in practice every already-indexed launch already proves
  its block exists, so a failure here should be rare.

`telegram`/`discord`/`farcaster` from `socials()` are read but **not stored**
— YAGNI: the reference screenshots only show Website and Twitter pills, and
nothing in this spec's scope displays the other three. Add them later if a
future design calls for them; re-reading on-chain data is cheap and doesn't
require a migration to retrofit.

All four columns are nullable with no default-to-empty-string fallback: a
token whose creator left `description()` empty gets `null`, not `""` — the
API and FE both treat `null` as "not provided," consistent with this
project's existing null-means-unavailable discipline.

### Metadata read (one-time, at launch-sync time)

Extend the existing per-launch RPC metadata read (`readV1TokenMetadata` /
the V2 equivalent, called once from `be/src/envioSync/runSync.ts` et al. when
a launch is first written to the real `launches` table) to also call
`logo()`, `description()`, `socials()` on the token contract, and
`eth_getBlockByNumber(launchBlock)` for the block timestamp, in the same
batch of calls. This is the same call site, same RPC client, same
once-per-launch cost model already used for `name()`/`symbol()`/`decimals()`
— no new indexing pipeline, no new schedule, no per-page-view RPC cost.

If any of these calls revert, time out, or return unexpected data (e.g. a
non-Pons-style token, or a contract that doesn't implement these functions),
the corresponding column(s) stay `null` — this must not throw and must not
block the launch itself from being indexed with its other fields.

### 1H/1D price-change computation

New function alongside `compute52WeekHighLow` in `be/src/market/aggregate.ts`,
using the same official-trade price history already queried for FDV/52-week:
find the latest trade at or before `now`, and the latest trade at or before
`now - 1h` / `now - 1d`; percent change = `(current - past) / past * 100`.
Returns `null` for a side with no trade in that lookback window (a token
younger than 1 day has a `null` 1D change, not a fabricated one derived from
its single launch trade). Gated by the same per-launch `complete` coverage
flag the existing FDV/52-week fields already use — incomplete coverage means
`null`, not a stale-looking number.

## API changes

`listLaunches`/`getLaunch` responses gain: `logoUri`, `description`,
`websiteUrl`, `twitterUrl`, `launchTimestamp` (straight passthrough from the
`launches` row, no RPC call per request — cheaper than the existing FDV/TVL
fields, which do need a live RPC read), and `change1h`, `change1d` (computed
the same way the 52-week fields already are, same coverage gating). OpenAPI regenerated per
the project's existing `npm run openapi:write` / FE `generate:schema` flow.

## FE changes

### List table (`fe/src/features/launches/launch-list.tsx`)

Columns: `#` (row rank within the current page), `Token` (resolved logo
image via the Pinata gateway with a placeholder/initial-letter fallback when
`logoUri` is null or the image fails to load, name, symbol, small Robinhood
Chain badge overlaid on the logo's bottom-right corner), `Launchpad` (small
platform logo + name, sourced from `/v1/sources`), `FDV`, `24H volume`,
`Liquidity`, `1H %`, `1D %` (red/green coloring for negative/positive, `—`
for null), `Age` (relative time computed from the new `launchTimestamp`
field, e.g. "80d"; falls back to `—` for the rare launch where the block
timestamp read failed).

Tabs: `All` (existing default), `Recently launched` (sort by launch time,
already available), `Trending` (sort by `change1h` descending, nulls last).

Filters: `Launchpad` dropdown sourced from `/v1/sources` (real, if currently
one-valued); chain logo shown as a label/single-option control, not a
functional filter.

### Detail page (`fe/src/features/launch/launch-detail.tsx`)

New "About" section: `description` (truncated with a "Show more" toggle when
long; hidden entirely if `null`), followed by pill buttons — token address
(with copy-to-clipboard), "Robinhood Explorer" (always shown — the link
itself is a pure template, no missing-data case), "Website" (hidden if
`websiteUrl` is `null`), "Twitter" (hidden if `twitterUrl` is `null`). No
empty/dead-link pills are ever rendered.

### IPFS gateway resolution

A small FE helper resolves `ipfs://<hash>` → `https://gateway.pinata.cloud/ipfs/<hash>`
for `<img src>`. Non-`ipfs://` URIs (if a token ever returns a plain
`https://` logo URL) pass through unchanged. Image `onError` falls back to a
placeholder (first letter of the symbol on a colored circle), never a broken
image icon.

## Known limitations (carried forward honestly, not fixed here)

- Pinata's public gateway is free and shared — it could itself start
  rate-limiting under real production load. No fallback gateway or
  self-hosted/API-key-backed gateway is in scope for this pass; this is a
  real operational risk to monitor after launch, not a blocker to building
  the feature now.
- Historical (pre-this-change) launches show no logo/description/links.
- `telegram`/`discord`/`farcaster` are read but not surfaced anywhere yet.

## Testing

TDD throughout, per project convention:

- Unit: the metadata-read extension (mocked RPC client — revert/empty-string
  cases), the 1H/1D computation (mirrors `compute52WeekHighLow`'s existing
  test shape: no-trade-in-window → null, exact-boundary trade, etc.), the
  IPFS-URI-resolution helper (ipfs:// → gateway URL, passthrough for non-ipfs
  URIs).
- Integration: sync-layer test proving a launch with real `logo()`/
  `description()`/`socials()` values lands correctly in the `launches` table,
  and a launch where those calls revert still gets indexed with `null`
  metadata columns (isolation — one launch's RPC failure must not fail the
  page/batch, matching the existing per-launch isolation pattern already
  proven for FDV/TVL).
- FE component tests: table renders all new columns correctly including
  null-state (`—` for null 1H/1D, placeholder avatar for null/failed logo);
  About section hides pills for null website/twitter/description and never
  renders a dead link.
