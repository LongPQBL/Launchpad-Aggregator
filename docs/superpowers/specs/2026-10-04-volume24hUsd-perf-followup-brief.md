# Brief: materialized/cached 24h USD volume for `sort=volume24hUsd`

> This is a handoff brief, not an approved spec. It describes the problem, what already
> exists, what was measured, and what a new spec needs to decide — written so another
> agent (or person) can turn it into a proper spec via the project's normal
> brainstorming → spec → plan flow (see `CLAUDE.md`'s "How to resume in Claude Code").
> It does not pre-approve any particular design.

## Background

Launchpad Aggregator indexes token launches from Pons on Robinhood Chain (`chainId=4663`).
The home/list page sorts launches by official 24h USD trading volume
(`GET /v1/launches?sort=volume24hUsd`). This was implemented as a read-side aggregate: on
every request, sum each launch's official trades from the last 24h, converted to USD via a
Chainlink price history table, entirely in SQL + Node, with no caching or precomputation.
Full spec: `docs/superpowers/specs/2026-10-04-launch-volume-ranking-design.md`. Full
implementation plan (now mostly executed): `docs/superpowers/plans/2026-10-04-launch-volume-ranking-implementation.md`.
Execution ledger with the exact numbers below: `.superpowers/sdd/2026-10-04-launch-volume-ranking-implementation/progress.md`.

## What already exists (do not rebuild — reuse/extend)

- `be/src/market/quotePricing/feedRegistry.ts` — `quote_usd_feeds` table: verified Chainlink
  feed address per `(chainId, quoteAssetAddress)`.
- `be/src/market/quotePricing/priceRounds.ts` — `quote_usd_price_rounds` table: every
  Chainlink `AnswerUpdated` round, keyed by `(chainId, feedAddress, roundId)`, with an index
  on `(chainId, feedAddress, blockNumber, logIndex)` for `findRoundAtOrBefore` — the causally
  correct "price at or before this exact trade position" lookup.
- `be/src/market/quotePricing/tradeValuation.ts` — `valueTradeUsd(pool, chainId,
  quoteAssetAddress, trade)`: the single shared rule for pricing one trade in USD.
  `status: 'priced' | 'pending' | 'unavailable'`. Rejects a round older than 24h relative to
  the trade's own timestamp (`MAX_PRICE_AGE_SECONDS`). Any new design must keep producing
  numbers consistent with this function (or replace both together, never let them diverge).
- `be/src/market/quotePricing/priceJobStore.ts` + `roundBackfill.ts` + `priceEnrichment.ts` —
  a background job queue (`price_jobs` table) that resolves new quote-asset feeds and
  backfills historical rounds, driven by a periodic loop (`be/src/cli/syncEnvioStagingLoop.ts`)
  and by demand-driven enqueue from `/trades` page loads.
- `be/src/api/store.ts`'s `listLaunchesByVolume` — the current read-side implementation.
  Two SQL queries: (1) every matching launch + its per-launch coverage-complete flag, (2)
  every official trade across all matching launches in the last 24h, LEFT JOINed to its feed
  and LATERAL-joined to its price round. Aggregates per launch in Node, ranks
  (positive-volume desc, then zero, then null-for-incomplete), paginates with an HMAC-signed
  cursor (`be/src/api/volumeCursor.ts`).
- `be/src/cli/generateSyntheticTrades.ts` / `benchmarkVolumeRanking.ts` — the synthetic-scale
  data generator and benchmark script used to measure the numbers below. Reusable for
  re-benchmarking any new design against the same scale.

## What was measured (the actual problem)

Synthetic data: 5,001 launches, 5,500,001 trades in a disposable `launchpad_test` database,
with ~180,200 trades falling inside the real last-24h window (the rest spread across the
simulated 30-day history, matching real-world "most launches aren't trading right now").

5 runs of `store.listLaunches({ limit: 50, chainId: 4663, sort: 'volume24hUsd' })`, first
(cold) discarded:

```
run1 (cold) = 138552.9ms
run2 = 6124.8ms
run3 = 4056.5ms
run4 = 5230.7ms
run5 = 4382.6ms
p50 = 4382.6ms   p95 = 6124.8ms
```

The frontend's real API timeout is 8000ms. Every warm run is under it (~24% margin on the
worst warm run), but over the benchmark script's own stricter self-imposed 3000ms
safety-margin gate.

`EXPLAIN (ANALYZE, BUFFERS)` on the 24h trades-with-price query (full plan in the ledger)
shows **every join already uses an index** — `trades_token_timestamp_idx`,
`launches_chain_id_token_address_pk`, `quote_usd_feeds_chain_id_quote_asset_address_pk`,
`quote_usd_price_rounds_position_idx`. There is no sequential scan on any indexed table, so
**no new index fixes this**. The cost is structural: the query re-resolves `launches` and
`quote_usd_feeds` once per *matched trade row* (180,200 times each: 540,600 + 360,400 buffer
hits respectively) instead of once per distinct launch/quote-asset. Total: 1,469,265 buffer
hits, 2,188.8ms execution time for that one query alone (the rest of the ~4-6s is query
planning/connection overhead/Node-side JSON deserialization and ranking of ~180K+5K rows,
plus repeated per-request work that a cache would avoid entirely).

## Decision already made

User chose (2026-10-04): design a materialized/cached volume summary now, rather than ship
the current read-side aggregate as-is. This brief is the input for that spec.

## What the new spec needs to decide

- **Where the 24h volume number is computed and stored.** Candidates to weigh: an
  Envio-maintained rolling aggregate entity (per the original design spec's own stated
  fallback: "An Envio-maintained summary is required if that read path misses the
  performance gate"), a periodic materialized-view/summary-table refresh job in `be/`
  (similar shape to the existing `price_jobs` background-loop pattern), or an
  incrementally-updated summary row maintained transactionally as trades are synced from
  Envio into the real tables (`be/src/envioSync/runSync.ts` / `runSyncV2.ts`).
- **Staleness tolerance.** A cached/materialized number is, by definition, not computed at
  request time — decide and document how fresh it must be (every sync cycle? every N
  minutes? on-demand invalidation?), and make sure the API continues to distinguish
  "complete and zero" from "unavailable/still backfilling" (CLAUDE.md: "null means
  unavailable/incomplete, never silently convert missing data to zero" — this constraint is
  non-negotiable and must survive into whatever caching layer is built).
- **Consistency with per-trade historical valuation.** `/trades` pages price each trade
  individually via `valueTradeUsd` (historical round at that trade's exact position). A
  cached 24h-sum must not silently drift from "the sum of what `/trades` would show for the
  same 24h window" — decide how the two stay reconcilable (same underlying valuation rule,
  periodic re-derivation, or an explicit documented tolerance).
- **Rank-correctness at pagination boundaries**, including the existing signed-cursor
  design (`be/src/api/volumeCursor.ts`) — if the new storage is pre-ranked/pre-sorted, the
  cursor's tiebreak logic may simplify or need to change; keep pagination stable while new
  data arrives between pages (the existing design's `asOf` pinning exists for this reason).
- **Reorg handling.** Envio/the sync path already has reorg-recovery guarantees for raw
  trades; any new aggregate/materialized layer must not reintroduce a window where a
  reorg'd trade's contribution to a cached sum is never corrected.
- **Interaction with the future `Pools` (other-pools) work unit.** CLAUDE.md (updated
  2026-10-04) now requires a separate `Pools` section covering all indexed pools (not just a
  launch's official venue), sharing the same verified quote/USD oracle registry and price
  rounds, with protocol-designated venue volume and all-pools volume kept distinct and never
  double-counted. If the new volume-summary design is Envio-maintained, consider (but do not
  over-build for) whether its shape could later be reused or kept parallel for that section
  — they must never silently merge the two volume concepts.
- **Scope of the migration.** Keep migrations additive (CLAUDE.md: "Keep migrations
  additive and preserve user data"); do not drop `quote_usd_feeds`/`quote_usd_price_rounds`
  or the existing read-side query — decide whether the read-side `listLaunchesByVolume`
  becomes a fallback, is deleted once the new path is proven, or stays for small-scale/local
  dev correctness-checking against the materialized path.
- **Re-benchmark requirement.** Whatever is designed must be re-measured with the same
  synthetic-scale tooling (`generateSyntheticTrades.ts` / `benchmarkVolumeRanking.ts`, or
  their successors) before being called done — this was the whole reason the prior read-side
  design was rejected: it must not be replaced by another design that nobody measured.

## Project constraints to carry into the new spec (do not relitigate)

From `CLAUDE.md`, applicable to any new design in this area:
- Solo developer, work directly on `main`.
- Null means unavailable/incomplete; never fabricate a zero.
- Label data source (e.g. "pons"); never imply an official partnership.
- New indexing work targets Envio, not any RPC-scan indexer (that subsystem was fully
  removed this session).
- Light UI, English frontend copy; Vietnamese is fine for solo-dev-facing docs only.
- Backend: Node.js ≥24, TypeScript, Fastify, viem, PostgreSQL, Drizzle, Vitest +
  PostgreSQL integration tests (never mock `pool.query` for anything touching real schema
  per this plan's own Task 1/2/4 convention).
- No wallet/trading/bridging/platform-fee work in this area; stay scoped to read-only launch
  and volume data.
