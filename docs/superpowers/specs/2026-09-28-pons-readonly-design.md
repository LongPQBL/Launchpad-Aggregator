# Spec 1 — Read-only pons data pipeline and web app

**Date:** 28 September 2026  
**Status:** Draft for user review; not an implementation plan  
**Audience:** One developer building a local-first launchpad aggregator

## 1. Intent and boundaries

Build one verifiable end-to-end slice: discover every historical and new token launched through pons on Robinhood Chain, follow its official trading lifecycle, and display the result in a responsive web app. The slice must prove that a platform adapter can be added without changing the common API or UI data model. It is the foundation for later full.fun integration on all of its launch-capable chains.

Success means that a user can find a pons token, see its originating launchpad, version, quote asset, lifecycle state, official chart, official trades, official 24-hour volume, and the data's sync status. No real or simulated trading is part of Spec 1.

In scope: pons v1 legacy and active factories, pons v2 factory, all launches from their verified deployment blocks, official trade history before and after graduation, historical backfill, live updates, recovery after disconnects, API, and minimal FE. Out of scope: token creation, wallet connection, buy/sell, application fees, holders, risk scoring, other launchpads/chains, unofficial pools, cross-chain transfers, and production deployment. Those are later slices, not silently dropped requirements.

## 2. Agreed technical choices

- Two top-level product folders: `fe/` and `be/`. Documentation remains in `docs/`.
- `fe/`: Next.js, React, TypeScript, Tailwind CSS, shadcn/ui; TradingView Lightweight Charts for token candles. Follow the chart library's attribution terms.
- `be/`: Node.js, TypeScript, Fastify, viem, PostgreSQL, Drizzle migrations. A long-running indexer and HTTP API are separate processes using the same BE modules and database.
- Tests: Vitest for deterministic domain/adapter tests; PostgreSQL-backed integration tests; Playwright for browser flows. Test fixtures use real, fixed on-chain log ranges wherever practical.
- No Redis, Kafka, Elasticsearch, or microservice-per-chain in this slice. PostgreSQL holds durable checkpoints and derived data. An optional Compose configuration may start PostgreSQL locally; FE and BE can run natively, and a native PostgreSQL installation is also supported. Docker Desktop is not a prerequisite.
- Fastify route schemas define the API contract. Export OpenAPI and generate FE types from it so FE/BE interfaces cannot drift silently.
- Add a small GitHub Actions CI workflow with the first code milestone: on pull requests and pushes to the main branch, run install, lint, TypeScript checks, deterministic adapter/domain tests, PostgreSQL-backed integration tests, and FE/BE builds. Add browser smoke tests once FE routes exist. CI must not depend on live public RPCs or submit transactions. Do not add CD until a deployment target and credentials policy are chosen.

## 3. Component boundaries

```text
fe/src/app + fe/src/features + fe/src/api
              │ HTTP initial reads / SSE updates
              ▼
be/src/api ──────────────── PostgreSQL
                              ▲
be/src/indexer ───────────────┘
       │
       ├── be/src/launchpads/pons/v1
       ├── be/src/launchpads/pons/v2
       └── be/src/chains (Robinhood RPC/WSS and chain registry)
```

`launchpads/pons/v1` and `launchpads/pons/v2` know contract addresses, ABIs, launch discovery, lifecycle, and venue-specific trade decoding. They emit the same normalized launch, venue, trade, and state records. `chains/` knows chain IDs, RPC endpoints, rate limits, and provider health; it does not contain pons-specific logic. `indexer/` owns bounded backfill, live subscriptions, checkpoints, deduplication, and reconciliation; it does not contain protocol-specific decoding. `api/` reads normalized data and never calls every launchpad or pool during a user request.

The adapter interface is defined around capabilities rather than one method per chain: enumerate launch sources, decode launch events, resolve official venue/lifecycle, and decode official trades. A platform may have multiple protocol-version adapters but reuse one chain provider. Adding full.fun later creates its adapter and three chain configurations, not three copies of the entire backend.

## 4. pons-specific source semantics

The on-chain factory and venue events are the authoritative launch/trade sources. Metadata is read from the token/launch contracts and cached with provenance. Factory address, protocol version, start block, ABI, and supported chain are registry entries, not conditions scattered through business logic.

- **v1:** Index `TokenLaunched` from both documented v1 factories, register each emitted Uniswap V3 pool, and index that pool's `Swap` events. Graduation changes status when the factory's `graduationStatus(token)` reports it; trading stays in the same pool. Do not invent a migration event or a new official pool. [pons v1 documentation](https://docs.ponsfamily.com/).
- **v2:** Index `TokenLaunched` from its factory, each launch's `CurveBuy`/`CurveSell`, and the launch's phase. Phase 0 trades on the curve; phase 1 (`Swept`) has no live pool; phase 2 uses the reconstructed official Uniswap V4 `poolId`; phase 3 (`Rescued`) is shown explicitly. After graduation, index only that identified V4 pool's swaps as official trades. The quote asset may be native ETH or an approved ERC-20; it is never assumed to be WETH. [pons v2 documentation](https://docs.ponsfamily.com/v2).
- The v2 source audit must verify the V4 PoolManager address, pool key/ID reconstruction, swap decoding, and at least one known graduated launch before post-graduation volume/chart coverage is declared complete. Public pons docs specify reconstruction but do not by themselves prove the project's indexer is correct.
- UI provenance is lowercase **pons** with a link to its app; version is available in technical details. The UI must not imply an official partnership. [pons attribution terms](https://docs.ponsfamily.com/).

## 5. Normalized data and metric definitions

Core identities are chain-aware. A token is identified by `(chainId, tokenAddress)`, not symbol/name. A launch record links that token to its source platform, protocol version, factory, launch transaction, quote asset, and lifecycle. A venue record has a chain-aware identity that can represent a V3 pool address, a bonding-curve contract, or a V4 pool ID; a single `poolAddress` field is insufficient for all three. Every official venue has an effective start/end in the launch timeline. This allows v1's one-pool timeline and v2's curve-to-pool timeline without rewriting history.

Each normalized trade stores chain, token, venue, block/transaction/log identity, timestamp, buy/sell side, actual settled token and quote amounts, quote asset, source event, and price provenance. Store integer on-chain amounts and token decimals; use decimal-string API values, not floating-point arithmetic for financial amounts. Raw logs remain auditable. A removed/reorganized log must be retractable, followed by recomputation of affected projections.

**Official volume** is the sum of actual quote legs of official venue trades in the selected period; it excludes refunds, fee-sweep/buyback events, and unrelated pools. For v2 it spans curve trades followed by the official V4 pool, never both venues for the same trade. The list page shows 24-hour official volume. A future additional-pool page will show that pool's own volume separately.

Candles are built in event order from verified venue prices in the launch's quote asset. v1 V3 and v2 V4 use decoded post-swap pool state. v2 curve prices are reconstructed from launch state and ordered curve events, including actual settled quote, fee, and tax fields; sampled historical `getReserves()` reads verify the reconstruction. If it cannot be verified, the chart segment is marked incomplete and an archive-state provider is required rather than substituting a fee-distorted execution price. Gross spend divided by tokens received is **not** silently treated as market price when fees/taxes are included. Empty intervals do not fabricate trades. Mark the v2 venue transition on the chart without resetting the token's official timeline.

Spec 1 displays price and volume in each launch's quote asset; it does **not** provide USD conversion or a cross-quote volume ranking. This avoids comparing ETH volume to an approved ERC-20 quote as if the units matched. The default list order is newest launch, and 24-hour official volume is shown with its quote-asset symbol. A later FX-source spec may add timestamp-appropriate USD conversion and comparable USD ranking. Missing quote-volume data is `null`/“Chưa có dữ liệu”, never zero.

## 6. Backfill, live updates, and failure handling

For every factory and official-venue stream, backfill from its verified deployment/launch block to a recorded safe head using bounded, adaptive `eth_getLogs` ranges. Save source-specific checkpoints only after a range's records and projections commit. Rate-limit/retry transient provider failures with bounded exponential backoff; shrink ranges when log-size limits are hit. Restarting the worker resumes rather than rescanning or double-counting committed ranges.

Subscribe over WSS for fast new-log detection when the provider supports it. Independently reconcile the gap from the last committed checkpoint to the safe head over HTTP after reconnect, on a schedule, and on process restart. Live-tip records may appear as provisional; confirmation depth is configurable per chain. On a reorg, retract logs from the replaced blocks and rebuild affected token projections before marking them confirmed. The app does not claim a fixed latency that public RPCs cannot guarantee; it exposes observed indexing lag in blocks/time.

Each source has explicit `backfilling`, `caught_up`, or `degraded` status, last scanned/confirmed block, and missing ranges. The API returns coverage with metrics. FE displays “Đang đồng bộ” or an error when relevant history is incomplete; it must not label a partial figure as complete or turn missing data into zero. Provider failures are observable without stopping already indexed tokens from loading.

Robinhood's public RPC is rate-limited and its official guidance recommends archive access for historical indexing. The local build starts with free endpoints, but **full-history acceptance is gated on verified access**, not assumed. If a public endpoint prevents a complete scan, the worker records the exact incomplete range and the project reports the provider requirement before claiming completion. [Robinhood connection guidance](https://docs.robinhood.com/chain/connecting/).

## 7. API and web behavior

Fastify exposes versioned read-only endpoints for supported chains/platforms, cursor-paginated launches with search/status/sort filters, launch detail, official venue timeline, official trades, candles, and per-source sync coverage. Stable token URLs use chain ID and address. SSE sends launch/trade/status changes to the browser; on SSE loss, FE refetches and can poll until reconnected. Initial pages load from the API through Next.js; charts and live tables are client-side islands.

The FE uses a dark, high-contrast trading dashboard based on shadcn/ui's dashboard blocks, customized rather than copied as a finished aggregator. Desktop prioritizes a scannable launch table; mobile uses a compact token layout. A launch page shows identity, pons provenance, chain, quote asset, lifecycle (including v2 `Swept`/`Rescued`), official price/chart/trades/24-hour volume, and sync status. A source filter is present in the design but does not show useless one-option controls in this first single-platform/single-chain slice. No wallet connection, simulated trade button, or disabled fake purchase panel appears in Spec 1.

## 8. Verification and acceptance

1. **Source registry:** verified factories, deployment blocks, ABIs, per-launch quote-asset extraction, V3 pool identification, V4 pool key/ID reconstruction, and a documented reference transaction for each important lifecycle state. The v1 legacy and active factories are both included.
2. **Historical coverage:** backfill from each source start block to a recorded safe head with no unexplained gaps; an independent overlapping/repeat scan or available on-chain total reconciles launch counts. A sample of launches is cross-checked against original logs and contract state. If coverage cannot be proven with available RPCs, the slice remains incomplete rather than reporting success.
3. **Lifecycle and metrics:** fixture tests cover v1 same-pool graduation; v2 curve trades, partial final buy/refund, phase transition, custom quote asset, and V4 post-graduation swaps. Confirm no double-counted trade or incompatible-quote sum. Sample prices and volumes are checked against raw source data.
4. **Reliability:** replaying the same ranges is idempotent; worker restart, WSS disconnect/gap repair, RPC range-limit reduction, and a simulated reorg yield the same canonical projections as a clean scan.
5. **API/FE:** cursor pagination, token identity/provenance, chart/trade consistency, incomplete-data messaging, desktop and mobile layout, and SSE reconnect/fallback are tested. Playwright tests are read-only and never submit a real transaction.
6. **Local reproducibility and CI:** one documented path starts FE, API, indexer, and PostgreSQL locally; database migrations and the test suite run from a clean checkout. Compose is optional, not required. GitHub Actions passes its deterministic checks against the same repository revision without live RPC credentials.

## 9. Delivery sequence and later work

Within this single spec, implement registry/domain schema and test fixtures first, then v1 launch/pool indexing as the simpler end-to-end proof, then v2 curve/graduation/V4 indexing, then API and thin FE, then reconciliation and hardening. UI may be developed against typed fixture responses in parallel with data work, but acceptance requires real indexed data.

After Spec 1 is approved, create a separate implementation plan. Subsequent specs cover full.fun on Robinhood/Arc/BNB with all-chain historical reconciliation; additional pool discovery/pages; verified holder and risk data; selected-venue simulated and real trading with configurable zero initial platform fee; and cross-chain transfers. Adding a new launchpad or chain must extend adapters/registry entries and tests without changing existing pons behavior.

## References

- [Research report](../../../launchpad-aggregator-research-report.md)
- [pons v1 integration and terms](https://docs.ponsfamily.com/)
- [pons v2 lifecycle, events, and pools](https://docs.ponsfamily.com/v2)
- [Robinhood Chain connection guidance](https://docs.robinhood.com/chain/connecting/)
- [shadcn/ui blocks](https://ui.shadcn.com/blocks)
- [TradingView Lightweight Charts documentation](https://tradingview.github.io/lightweight-charts/docs/5.0)
