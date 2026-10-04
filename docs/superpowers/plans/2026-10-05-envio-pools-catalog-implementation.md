# Envio Pools Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Planning only in this session; do not execute yet.

**Goal:** Expose verified indexed pools, pool-scoped swaps/metrics, a global Pools page, each Pons token's exact-match Pools section, and pool details without changing official Pons launch metrics.

**Architecture:** Promote all configured V4 Initialize/Swap raw events into a chain-scoped pool catalog, member index, and canonical pool trades. Pool-specific readers calculate or cache price, historical USD volume, chart, TVL, and changes using verified trade-time pricing; API/UI keep pool metrics separate from launch metrics. Add V3/V2 only after explicit Envio source and parity work.

**Tech Stack:** Envio, TypeScript, PostgreSQL/Drizzle, viem, Fastify/OpenAPI, Next.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-envio-data-coverage-pools-retention-design.md` §§ Official venues and other pools.

## Global Constraints

- A pool belongs to a token page only when chain and address equal `currency0` or `currency1`; discovery never makes it a Pons-designated venue.
- `officialVolume24hUsd` and official chart/trades remain limited to `venues.official`; pool swaps contribute once to their own pool metrics.
- V4 pool identity is `(chainId, protocol, poolId)` verified from ordered currencies, fee, tick spacing, and hook. Preserve native ETH as zero address in storage.
- No current USD price applied to old swaps. Missing oracle, token supply, coverage, or liquidity inputs render `null`/`—`, not zero or another pool's metric.
- Global list includes only verified, indexed supported pools. No APR/Rewards APR, wallet, or trading work. Frontend copy in English.
- Migrations additive; run on disposable databases first. Work on `main` without subagents.

## Review Focus

- A false Pool ID/currency pair cannot enter the catalog and cannot appear on a token page (Tasks 1 and 2).
- One official V4 swap appears in both its pool feed and Pons official feed but is counted once within each metric, never twice (Tasks 2 and 3).
- ETH zero address stays zero in storage and only gets a display symbol at the UI edge (Tasks 1 and 5).
- A pool with one unpriced positive trade has unavailable 24-hour USD volume, not a partial sum (Task 3).
- A V3/V2 pool is absent or explicitly unsupported until its own Envio factory/pool source passes parity (Task 6).

## File Map and Dependencies

Create `be/src/pools/` modules for identity, sync, store, valuation, stats, and API readers. Extend `be/src/envioSync/syncAll.ts` and V4 raw-table access without altering Pons-only `runSyncV4.ts` semantics. Add pool routes under `be/src/api/routes/`; add FE `/pools` and `/pools/[chainId]/[protocol]/[poolId]` pages plus a launch-detail section. Generate migration and OpenAPI/FE types at execution time. The near-realtime plan should land first so pool sync uses bounded cursors and repair; the launch coverage plan may run independently. The retention plan must include these pool trade tables before enabling archive/deletion.

**Verification commands:** Run BE unit files with `cd be && npm test -- src/<named-file>.test.ts`, BE integration files with `cd be && npm run test:integration -- src/<named-file>.integration.test.ts`, FE test files with `cd fe && npm test -- src/<named-file>.test.tsx`, and Envio tests with `cd envio && npm test`. Full gates are BE/FE `npm test`, `npm run test:integration` (BE), `npm run typecheck`, and `npm run lint`; regenerate/check schemas with the repository `openapi:write`, `openapi:check`, `generate:schema`, and `check:schema` scripts. RED means the intended behavior fails, not fixture setup.

### Task 1: Verified pool identity and catalog schema

**Files:** Create `be/src/pools/identity.ts`, `identity.test.ts`, `be/src/pools/catalog.ts`, `catalog.integration.test.ts`; modify `be/src/db/schema.ts`; generate migration.

**Interfaces:** `verifyV4Initialize(raw): VerifiedPool | null`; `upsertVerifiedPool(tx, pool): Promise<void>`; catalog key `(chainId, protocol, poolId)` and member key `(chainId, protocol, poolId, tokenAddress)`.

- [ ] Test valid and mismatched V4 Pool IDs, ordered currencies, zero-address ETH, duplicate Initialize, reorg replacement, and exact membership for both currencies.
- [ ] Run BE unit/integration targeted tests; expect RED.
- [ ] Reuse the existing V4 pool-key verification math from `be/src/envioSync/transformV4.ts`; persist protocol, currencies, creation position, fee/hook/tick spacing, verification, coverage, and member index. Keep official designation as a separate relation to existing `venues`.
- [ ] Run targeted tests and typecheck; expect PASS. Commit.

### Task 2: Bounded V4 catalog/swaps sync and reorg repair

**Files:** Create `be/src/pools/syncV4Pools.ts`, `syncV4Pools.integration.test.ts`; modify `be/src/envioSync/syncAll.ts`, shared incremental cursor/repair modules.

**Interfaces:** `syncV4PoolPage(envioPool, appDb, { fence, cursor, limit }): Promise<PoolSyncPageResult>` and `repairPoolWindow(..., depth: 500n): Promise<RepairReport>`.

- [ ] Test non-Pons V4 Initialize/Swap promotion, swap-before-Initialize retry, duplicate/overlap, official-pool overlap, reorg deletion/replacement, and restart after partial page failure.
- [ ] Run targeted integration; expect RED.
- [ ] Read all configured V4 raw pools in bounded keyset pages, not only Pons pool IDs. Persist unique canonical swap keys and token-side membership; repair only affected pool keys. Preserve Pons official trade rows and metrics.
- [ ] Run targeted integration, typecheck, and lint; expect PASS. Commit.

### Task 3: Pool-scoped historical valuation and metrics

**Files:** Create `be/src/pools/valuation.ts`, `stats.ts`, `stats.integration.test.ts`, `candleCache.ts`; reuse `be/src/market/quotePricing/` rules and existing candle worker patterns.

**Interfaces:** `readPoolStats(pool, key, displayedToken, asOf): Promise<PoolStats>`; `PoolStats` includes nullable USD 24h volume, TVL, pool price, 1h/1d change, displayed-token FDV, completeness/freshness, and pool-only candles/high-low. `readPoolTrades(...): Promise<Page<PoolTrade>>` is ordered by canonical event position.

- [ ] Test exact one-swap contribution, quote/price historical round selection, unpriced and incomplete cases, both displayed sides, supply missing, no trade window, TVL unavailable, and pool-only chart boundaries.
- [ ] Run targeted integration; expect RED.
- [ ] Value each swap once in pool context using verified quote/USD history; calculate FDV from this pool's verified displayed-token USD price and verified total supply. Build bounded pool candles/aggregates with dirty-bucket reorg repair; do not read Pons official candles as pool candles.
- [ ] Run targeted integration and typecheck; expect PASS. Commit.

### Task 4: Pools API and coverage contract

**Files:** Create `be/src/api/routes/pools.ts`, `be/src/api/poolStore.ts`; modify `be/src/api/server.ts`, `schemas.ts`, `be/openapi.json`; test `be/src/api/pools.integration.test.ts`, `server.test.ts`.

**Interfaces:** `GET /v1/pools`, `GET /v1/pools/:chainId/:protocol/:poolId`, `GET .../trades`, `GET .../candles`, and `GET /v1/launches/:chainId/:tokenAddress/pools`. List filters and cursors apply before ordering; pool ID is validated/encoded safely in routes.

- [ ] Test global list of supported verified pools, exact chain/address token membership, pool detail identity, pagination/filter ties, incomplete metrics, unknown/unsupported protocol, and official launch-volume isolation.
- [ ] Run targeted API/integration; expect RED.
- [ ] Implement indexed list and pool readers, explicit supported-source coverage, and OpenAPI nullable metric schemas. Never claim all Robinhood pools are indexed.
- [ ] Regenerate OpenAPI and FE schema; run BE integration/typecheck/lint; expect PASS. Commit.

### Task 5: Global Pools, Pons Pools section, and pool detail UI

**Files:** Create `fe/src/app/pools/page.tsx`, `fe/src/app/pools/[chainId]/[protocol]/[poolId]/page.tsx`, `fe/src/features/pools/pool-list.tsx`, `pool-detail.tsx` and tests; modify `fe/src/features/launch/launch-detail.tsx`, `fe/src/api/client.ts`.

- [ ] Test global list defaults to currency0, launch detail fixes displayed side to matching Pons token, links preserve displayed side, pool-detail switch flips sides, missing metrics show `—`, coverage/freshness shown, and no APR columns.
- [ ] Run targeted FE tests; expect RED.
- [ ] Build responsive list/card layout consistent with launch list; label Pons-designated pool and `FDV (pool price)`. Show pair, DEX/version, verified fee/hook, age, liquidity, volume, price/change, pool chart, and paginated pool trades. Link back to launch detail when applicable.
- [ ] Run FE tests, typecheck, lint, and a local page smoke test; expect PASS. Commit.

### Task 6: V3/V2 source expansion and parity gate

**Files:** Modify `envio/config.yaml`, `envio/schema.graphql`, `envio/src/EventHandlers.ts`; create `be/src/pools/syncV3V2Pools.ts`, tests; update source registry and parity CLI.

- [ ] First record verified factory/pool addresses, deployment blocks, event ABIs, and a bounded read-only event sample for each version; do not configure unsupported versions from metadata guesses.
- [ ] Test V3/V2 factory event identity, token order, swap uniqueness, restart/reorg, and parity against bounded source logs; expect RED before implementation.
- [ ] Add Envio sources and promote only verified pools and swaps. A failed or incomplete parity audit leaves that version visibly unsupported/incomplete in the API.
- [ ] Run Envio/BE tests, typecheck, and disposable-DB parity probe; expect PASS before enabling UI coverage labels for either version. Commit.
