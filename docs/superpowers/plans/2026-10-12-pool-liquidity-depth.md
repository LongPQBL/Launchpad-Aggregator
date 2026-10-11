# Pool Liquidity and Depth charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native execution chosen by the user). Steps use checkbox syntax.

**Goal:** Pool pages for V3/V4 get Liquidity and Depth tabs in the existing tab switcher, backed by tick liquidity read from the chain; the bonding-curve page gets a Depth tab computed from the curve's constant-product state.

**Architecture:** Pure tick math (`liquidityMath.ts`) + chain readers for V3 (`tickBitmap`/`ticks`) and V4 (`PoolManager.extsload`) (`liquidityRead.ts`) + one read-only endpoint with a 60 s cache; the frontend adds two tabs whose "uses range / uses chart style" flags decide which controls show.

**Tech Stack:** TypeScript, Fastify, viem, Vitest, Next.js, Lightweight Charts.

**Spec:** `docs/superpowers/specs/2026-10-12-pool-liquidity-depth-design.md`

## Global Constraints

- null/unavailable, never a guess; any read failure makes the whole answer unavailable.
- V3 and V4 only (V2 answers 404 and shows no tabs). Frontend copy in English. Stage explicit files only (user WIP in `fe/`).
- Green accent for Liquidity; Depth uses green bids / red asks (semantic).

## Review Focus

- Empty pool (no ticks): `ranges: []`, `complete: true`, a real "no liquidity", not an error.
- Active-range liquidity differing from the pool's reported `liquidity`: whole answer unavailable.
- V4 pool with custom accounting: `unavailableReason: 'custom_accounting'`.
- Flipped token order / differing decimals (6 vs 18) must not distort prices.
- Pool with spacing 1: word count cap hit → `complete: false`, not a hang.

### Task 1: Tick math

**Files:** Create `be/src/pools/liquidityMath.ts`, `be/src/pools/liquidityMath.test.ts`.

**Produces:**
- `tickToPrice(tick: number, decimals0: number, decimals1: number): number` (token1 per token0)
- `buildRanges(ticks: { tick: number; liquidityNet: bigint }[], currentTick: number): LiquidityRange[]` with `LiquidityRange = { tickLower: number; tickUpper: number; liquidity: bigint; active: boolean }`
- `buildDepth(input: { ranges: LiquidityRange[]; currentTick: number; sqrtPriceX96: bigint; tickSpacing: number; decimals0: number; decimals1: number; feePips: number; maxRows?: number }): DepthResult`
  with `DepthRow = { price: number; amount0: number; total1: number; cumulative1: number }`, `DepthResult = { asks: DepthRow[]; bids: DepthRow[]; spreadPercent: number | null }`

- [ ] Write tests: `tickToPrice(0, 18, 18) === 1`; `tickToPrice(0, 18, 6) === 1e-12`... (decimal adjust `10^(d0-d1)`); `buildRanges` for ticks `[{-100,+10n},{100,-10n}]` and current 0 → one range `{-100,100,10n,active:true}`; empty ticks → `[]`; ranges sum to zero at the end; `buildDepth` of one range with known L reproduces `amount0 = L*(1/sqrtPa - 1/sqrtPb)` within 1e-9 relative.
- [ ] Run `npm run -w be test -- liquidityMath` → FAIL; implement; → PASS.
- [ ] Commit `feat(pools): tick liquidity math`.

### Task 2: Chain readers

**Files:** Create `be/src/pools/liquidityRead.ts`, `be/src/pools/liquidityRead.test.ts`.

**Consumes:** Task 1 types. **Produces:**
`readPoolLiquidity(client: UsdPriceClient & { getBlockNumber(): Promise<bigint> }, pool: { protocol: 'uniswap_v3' | 'uniswap_v4'; poolId: string; currency0: string; currency1: string; fee: number; tickSpacing: number }, options?: { maxWords?: number }): Promise<{ blockNumber: bigint; tick: number; sqrtPriceX96: bigint; liquidity: bigint; ticks: { tick: number; liquidityNet: bigint }[]; complete: boolean; unavailableReason: string | null }>`.

- [ ] V3: read `slot0`, `liquidity`, `tickBitmap` for words `floor(minTick/spacing/256)..floor(maxTick/spacing/256)` (min/max = ±887272), then `ticks(t)` for set bits. V4: `stateSlot = keccak256(abi.encode(poolId, 6))`; `slot0 = extsload(stateSlot)`; `liquidity = extsload(stateSlot+3)`; bitmap word `w` at `keccak256(abi.encode(int16 w, stateSlot+5))`; tick `t` at `keccak256(abi.encode(int24 t, stateSlot+4))` (low 128 bits gross, high 128 signed net).
- [ ] Tests with a fake client: V3 two initialized ticks → expected `ticks`; read throws → `unavailableReason: 'read_failed'`; words over `maxWords` → `complete: false`; V4 slot math returns the known slot for a fixed pool id (compute the expected value in the test with viem `keccak256`).
- [ ] Live check (script, not committed): V4 pool `activeLiquidity` from `getPoolTVL` equals the sum of `liquidityNet` up to the current tick; V3 pool `liquidity()` equals the active range.
- [ ] Commit `feat(pools): read tick liquidity from V3 and V4 pools`.

### Task 3: Endpoint

**Files:** Modify `be/src/api/routes/pools.ts`, `be/src/api/schemas.ts` (`poolLiquidity`), `be/src/api/server.ts` (data interface `getPoolLiquidity`), `be/src/api/store.ts`; Create `be/src/pools/liquidity.ts` (assembles reader + math + cache), `be/src/pools/liquidity.test.ts`, integration in `be/src/api/poolStore.integration.test.ts`. Regenerate `be/openapi.json` and `fe/src/api/schema.ts`.

**Produces:** `GET /v1/pools/:chainId/:protocol/:poolId/liquidity` returning the spec's shape; 404 for V2/unknown pool; `custom_accounting` for V4 pools whose lens `hasCustomAccounting` is true.

- [ ] Tests: assembly with a fake reader (ranges, `active`, `depth`, `complete`); empty pool → `ranges: []`, `complete: true`; mismatch between the active range and reported liquidity → `unavailableReason: 'liquidity_mismatch'`; cache returns the same answer inside 60 s; route 404 for V2.
- [ ] Implement; `npm run -w be openapi:write`, `npm run -w fe generate:schema`; run unit + integration (`VOLUME_CURSOR_SECRET=x`).
- [ ] Commit `feat(api): pool liquidity and depth endpoint`.

### Task 3b: Curve depth (backend)

**Files:** Create `be/src/pools/curveDepth.ts`, `be/src/pools/curveDepth.test.ts`; modify `be/src/api/routes/launches.ts`, `schemas.ts`, `server.ts`, `store.ts`; regenerate OpenAPI/FE schema.

**Produces:** `buildCurveDepth(state: { quoteReserve: bigint; tokenReserve: bigint; feeBps: bigint; realQuoteReserve: bigint; graduationThreshold: bigint; quoteDecimals: number; tokenDecimals: number; maxRows?: number }): DepthResult` (same `DepthResult` as Task 1) and `GET /v1/launches/:chainId/:tokenAddress/curve/depth`.

- [ ] Tests: constant-product identity (cost to move the price to `P'` equals `sqrt(k*P') - Q` grossed up by the fee, within 1e-9); asks end exactly at `graduationThreshold - realQuoteReserve` of quote; bids end at `realQuoteReserve`; a curve at the threshold has no asks; a graduated phase answers `unavailableReason: 'graduated'`; 404 without a curve venue.
- [ ] Live check: compare the quote for a mid-size buy from the formula against `eth_call` of the curve's `buy` simulation (as `curve-guess.ts` documents) on a real curve.
- [ ] Commit `feat(api): bonding-curve depth`.

### Task 4: Frontend

**Files:** Modify `fe/src/features/pools/pool-chart-panel.tsx`, `fe/src/features/launch/official-chart.tsx` (hide range tabs via prop), `fe/src/api/client.ts` (`getPoolLiquidity`); Create `fe/src/features/pools/pool-liquidity-chart.tsx`, `pool-depth-chart.tsx`, `pool-depth-table.tsx`, `chart-kinds.ts`, with tests.

**Produces:** `CHART_KINDS: Record<ChartKind, { label: string; usesRange: boolean; usesChartStyle: boolean }>` in `chart-kinds.ts`; the panel renders range tabs only when `usesRange`, the line/candle switch only when `usesChartStyle`.

- [ ] Tests: V3/V4 pool shows Price, Volume, Liquidity, Depth; V2 shows Price, Volume; on Liquidity/Depth neither range tabs nor the style switch render; loading/error/unavailable states; Depth table rows (asks above, spread row, bids below).
- [ ] The curve page tab switcher becomes Price, Volume, Depth; its Depth tab reuses the pool Depth chart and table and shows the graduation/zero ends and the "excludes creator tax and snipe protection" note.
- [ ] Implement the components (dotted grid, green Liquidity bars with the active range brighter and a current-price marker, Depth cumulative areas green/red with zoom in / fit / zoom out, order-book table).
- [ ] `npx tsc --noEmit`, eslint, vitest on touched dirs; commit `feat(fe): Liquidity and Depth tabs`.

### Task 5: Real-UI check

- [ ] Start API (`dev:api` on a free port) and the FE dev server against it; open a real V3 pool page (a Pons V1 official pool) and a V4 pool in Chrome; check Liquidity (single wide bar expected for Pons pools), Depth and the table, the hidden range/style controls, and the unavailable states; also a mock page with many ticks (extend `fe/e2e/mock-api.ts`). Fix what is wrong, send screenshots, stop the servers.
