# Pons TVL Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the existing TVL field for Pons curve, V3 pool, and V4 pool with phase-specific on-chain amounts and visible valuation provenance.

**Architecture:** A venue reader returns raw asset amounts and a basis tag at one block. An address-keyed quote pricer supplies USD values; the API combines amounts, current pool price, and provenance for the current official venue only. The UI keeps the label TVL and explains the basis for the current phase.

**Tech Stack:** TypeScript, viem, PostgreSQL, Fastify, Next.js, Vitest.

**Spec:** [docs/superpowers/specs/2026-10-01-pons-tvl-correction-design.md](../specs/2026-10-01-pons-tvl-correction-design.md)

## Global Constraints

- Curve TVL = `realQuoteReserve × quoteUsd`; never use phantom quote or unsold launch token.
- V3 TVL uses ERC-20 balances held by its own pool. V4 TVL uses Uniswap ReservesLens for the exact pool ID.
- A launch with no trusted quote USD price or incomplete state has `tvlUsd: null`, never `0`.
- UI label is always `TVL`; tooltip text differs for curve and pool.
- Read on-chain amounts at one pinned block and retain integer raw amounts until final decimal formatting.
- Quote assets are keyed by chain and address. USDG uses its live USDG/USD Chainlink feed; unknown Stock Token quotes are discovered through the Robinhood asset registry and Chainlink feed directory.
- Preserve unrelated dirty workspace changes; do not rebuild/index all launches.

## Review Focus

- A USDG curve's phantom quote must not inflate TVL; compare `getReserves()` and `realQuoteReserve()` in a test.
- A V4 pool must never inherit another pool's PoolManager balance.
- The verified Pons hook sets the lens custom-accounting flag for fee extraction; use its core principal only, and reject unknown hooks or incomplete paged lens results.
- A launch transitioning curve → swept → V4 must switch TVL basis and never read a closed curve as current.
- One failed on-chain read must not erase otherwise valid stats or fail the whole list response.

---

### Task 1: Quote USD valuation and new-quote discovery

**Files:** Modify `be/src/market/usdPricing.ts`, `be/src/market/usdPricing.test.ts`; create `be/src/market/quoteFeedRegistry.ts` and `be/src/market/quoteFeedRegistry.test.ts`.

**Interfaces:** Keep `readUsdPrice(client, quoteAssetAddress)`; extend its result with `source: 'chainlink'` and preserve `updatedAt`. Key USDG by `0x5fc5360d0400a0fd4f2af552add042d716f1d168`, using feed `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`. Preserve current ETH/WETH mappings. `quoteFeedRegistry.resolve(address)` refreshes Robinhood `/rhj/assets` and Chainlink `feeds-robinhood-mainnet.json` on a bounded TTL, joins only canonical chain-4663 contract addresses to unique USD feeds, and returns `null` for unverified assets.

- [ ] Write failing tests proving USDG reads its feed, a canonical NVDA address finds its feed after registry refresh, a forged ticker address remains `null`, and a later newly listed quote is found after TTL expiry.
- [ ] Run `npm test -- src/market/usdPricing.test.ts src/market/quoteFeedRegistry.test.ts` in `be/` and confirm missing behavior fails.
- [ ] Implement feed mapping, TTL/in-flight refresh and provenance. Validate feed answer and timestamp with the existing Chainlink checks.
- [ ] Run the focused tests and `npm run typecheck`; commit only Task 1 files.

### Task 2: Raw venue amounts

**Files:** Create `be/src/market/tvlReserves.ts`, `be/src/market/tvlReserves.test.ts`; update `be/src/market/tokenStats.ts` and test only as needed.

**Interfaces:** Export `readVenueAmounts(client, input): Promise<{ tokenRaw: bigint; quoteRaw: bigint; blockNumber: bigint; basis: 'curve_real_quote' | 'pool_custody' | 'pool_principal' } | null>`. Input has `kind`, `ref`, `token`, `quote`, `v4PoolFee`, `v4TickSpacing`, `hook`, and `blockNumber`; curve reports `tokenRaw = 0n` by the TVL convention. Validate V3 token0/token1 and V4 derived pool ID. Use core principal even when the verified Pons hook sets `hasCustomAccounting`, because its custom delta extracts fees after swaps; reject unknown hooks or incomplete lens result.

- [ ] Write failing tests for curve real vs phantom quote, six-decimal USDG, V3 two balances, V4 per-pool lens result, and mismatched pool identity.
- [ ] Run `npm test -- src/market/tvlReserves.test.ts` and observe the expected failures.
- [ ] Implement readers with pinned `blockNumber`, existing Pons V4 key derivation, and official Uniswap ReservesLens ABI/address.
- [ ] Run focused tests, `npm run typecheck`, and a read-only real-chain probe of one curve and one graduated pool; commit Task 2 files.

### Task 3: API composition and metadata

**Files:** Modify `be/src/api/store.ts`, `be/src/api/server.ts`, `be/src/api/schemas.ts`, `be/src/market/tokenStats.ts`, associated API and market tests, `be/openapi.json`.

**Interfaces:** Add `tvlBasis`, `tvlBlockNumber`, `tvlPriceSource`, `tvlPriceUpdatedAt`, and `tvlUnavailableReason` to `LaunchSummary`. Preserve `tvlUsd`. Query the current official venue and V4 terms per displayed launch, then call Task 2 reader. Compute USD with integer/decimal arithmetic and current canonical pool spot; curve uses only quote. Isolate TVL failures from FDV/52W failures.

- [ ] Write failing list/detail tests for curve USDG TVL and provenance, V3/V4 value, swept `null`, and per-launch failure isolation.
- [ ] Run focused API tests and confirm the new assertions fail.
- [ ] Implement current-venue lookup and TVL composition; regenerate OpenAPI with `npm run openapi:write`.
- [ ] Run backend test, typecheck, lint, build, OpenAPI check; commit Task 3 files.

### Task 4: TVL display and final verification

**Files:** Modify `fe/src/features/launch/launch-detail.tsx`, the launch list component, their tests, and generated `fe/src/api/schema.ts`.

**Interfaces:** Keep the visible label `TVL`. Curve tooltip explains real quote only; pool tooltip explains two-token market value. A `null` value displays unavailable state, not `$0`.

- [ ] Write failing component tests for curve/pool tooltip copy and `null` display.
- [ ] Run focused FE tests and confirm failure.
- [ ] Implement display, run `npm run generate:schema`, then run FE tests, typecheck, lint, build and schema check.
- [ ] Run all backend and frontend tests, review the diff against the spec, and commit Task 4 files.
