# Minor quality fixes: frontend, API, and Envio sync

Date: 2026-10-04

## Intent and scope

Collect the owner's remaining small issues in one reviewable spec. Each item can be implemented independently. The 24-hour USD ranking and historical transaction USD valuation remain in `2026-10-04-launch-volume-ranking-design.md`; this batch does not implement them. The metadata retry fix and chain/platform image work are already complete. New indexing changes in this batch apply to Envio sync only, not the legacy RPC indexer.

Frontend copy stays English. Preserve honest unavailable states: missing data must not become zero or an invented link.

## About section and external content

### Description expansion

`fe/src/features/launch/about-section.tsx` currently renders `Show more` for every non-null description even when `line-clamp-3` does not clip it. Show the control only when the rendered collapsed paragraph actually exceeds three lines. Measure DOM overflow after layout and on width/description changes; do not infer line count from character length. Keep the current `Show more` / `Show less` labels and preserve meaningful whitespace and line breaks. Null, empty, and whitespace-only descriptions have no paragraph or toggle. A hidden measurement copy, if used, must be excluded from the accessibility tree. Tests should cover short text, long text, manual newlines, expansion, and desktop/mobile wrapping; use a browser check for actual line layout because jsdom does not calculate it.

### Address copy

`copyAddress()` currently assumes `navigator.clipboard.writeText` exists and succeeds. Catch both API absence and rejected writes, never leave an unhandled promise rejection, and show a short failure message with the full address selectable for manual copying. Show `Copied` only after a successful write, and reset the prior success/error state on a new attempt. Do not add a deprecated `execCommand` fallback. Test missing Clipboard API, rejected write, and success.

### User-provided URLs and logo

Treat `websiteUrl`, `twitterUrl`, and `logoUri` as untrusted onchain text. At the rendering boundary, accept only valid `http:`/`https:` URLs with a hostname for links and remote images; preserve valid `ipfs://` logo support by resolving it to the verified HTTPS gateway. Reject `data:`, `javascript:`, malformed, and relative URLs. An invalid website or Twitter URL hides its pill; an invalid logo shows the existing initial-letter placeholder. Keep `target="_blank"` links protected with `rel="noreferrer noopener"`. The `twitterUrl` value comes from Pons token `socials().twitter`, which the token creator can set; keep any valid HTTP(S) value from that field without imposing an x.com/twitter.com host requirement. Do not present an arbitrary external domain as verified by the app.

### Chain explorer

`launch-detail.tsx` currently substitutes Robinhood Explorer whenever `chainExplorerBase(chainId)` is undefined. Derive the About section's token-explorer link from the registered chain explorer only. Make `explorerUrl` optional and hide the pill for an unknown chain; do not link to Robinhood for another chain. The existing Robinhood link remains available for chain 4663. Test both registered and unknown chain IDs.

### Mobile launch cards

The mobile launch list renders several bare metric values; when they are null, a card can become a row of unexplained dashes. Show compact visible labels for FDV, 24H volume, TVL, 1H change, 1D change, and age at mobile widths, including unavailable values. Keep desktop table headers and values as they are. Confirm long labels/values fit a narrow viewport and that labels remain accessible.

## Backend and API cleanup

### Shared metadata type

The shape `{ logoUri, description, websiteUrl, twitterUrl, launchTimestamp }` is repeated in Pons V1/V2 adapters and Envio transforms. Export one `ExtendedLaunchMetadata` interface from `be/src/launchpads/pons/extendedMetadata.ts`, based on the existing four-field `ExtendedTokenMetadata`, and use it at those call sites. Preserve runtime behavior and nullable values; a type-only change needs typecheck rather than duplicate behavior tests.

### Envio V2 metadata reads

In `be/src/envioSync/runSyncV2.ts`, independent metadata, quote-asset, extended-metadata, and launch-block reads currently await in sequence per new/rebuilt launch. Start the independent reads together and await them as one group, matching the V1 Envio sync pattern. Keep the known native-ETH quote fast path, existing read outcomes, and persisted retry states. A failed required metadata/quote read must still fail that launch's sync; a transient extended-metadata or timestamp failure must remain pending for the Envio enrichment worker. Verify concurrency with deferred test promises and verify one failure does not turn an optional field into a permanent null.

### Launch timestamp storage

`launches.launch_timestamp` is PostgreSQL `integer` (int4). Migrate it to `bigint` without changing existing values, and update Drizzle schema to use bigint in JavaScript number mode for Unix-second timestamps (which are safely below `Number.MAX_SAFE_INTEGER`). Keep the API's string form and the existing `number | null` domain shape. Test migration from an existing int4 value and persistence of a timestamp above the int4 maximum.

### Price formatting work

`computeStats()` in `be/src/api/store.ts` formats each 52-week trade price twice, once for high/low and once for 1H/1D change. Format once per row and reuse the resulting price string. Preserve metric values and coverage/error behavior; existing aggregate/API tests are the regression gate.

### Lean launch-list response

The list API returns full `description` text for every launch although the list does not display it. Remove description from the launch-list response and avoid selecting it from `launches` for that query. Keep it in launch detail. Define distinct summary/list and detail response shapes in `be/src/api/server.ts` and `be/src/api/schemas.ts`, regenerate OpenAPI and frontend types, and update list mocks/tests. Other fields used by list cards remain available. Test that list items omit `description` while detail still returns it.

## End-to-end assertion

The detail-page e2e test formerly asserted zero buttons, then changed to a name pattern when legitimate About buttons appeared. The app now also has a wallet control in its header. Assert the intended behavior directly: the header may contain wallet connection, About may contain copy/expand controls, and the read-only detail content has no buy/sell/swap execution control. Avoid a blanket zero-button assertion or a text search that treats trade-history labels as trading actions.

## Verification and boundaries

Run the focused frontend/backend tests for behavior changes, DB migration test, generated OpenAPI check, typechecks, lint, and frontend build. Exercise the description clamp and mobile labels in a real browser at narrow and wide widths. No live migration, deployment, USD ranking work, or legacy-indexer changes are part of this spec. Implement the items as separately reviewable commits within this one batch spec.
