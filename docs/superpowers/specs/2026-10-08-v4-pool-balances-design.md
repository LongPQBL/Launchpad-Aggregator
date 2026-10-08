# V4 Pool Balances Design

**Approved scope:** show the two current token balances and a value composition bar in the V4 Pool balances section, using the same pool-specific data source already used for V4 TVL. The current page shows no V4 balances because a V4 pool does not custody its tokens at a dedicated pool address; all pools share the PoolManager.

## Current behavior

`fe/src/features/pools/pool-balances.tsx` reads ERC-20/native balances directly from a pool contract for V2/V3. It intentionally renders an unavailable message for V4, since reading the shared PoolManager balance would combine assets from every V4 pool.

The backend already reads the pool-specific `getPoolTVL(POOL_MANAGER, PoolKey)` result from Reserves Lens in `be/src/pools/stats.ts` to calculate V4 TVL. The result includes `coreAmount0`, `coreAmount1`, `sqrtPriceX96`, `hasCustomAccounting`, and a block number, but the current helper returns only TVL and discards the token amounts.

## Design

Refactor the V4 lens read to retain the pool's principal token amounts and spot price from the same lens snapshot. Extend the pool summary API with a nullable `poolBalances` object containing raw integer token amounts in displayed-token order (`displayedAmountRaw`, `otherAmountRaw`) and the corresponding spot `priceInQuote`. Raw amounts remain decimal strings in JSON so integer precision is preserved. For V2/V3 this field is `null`; their existing direct on-chain balance reads remain unchanged.

Return `poolBalances: null` when the lens call fails, token decimals or spot price cannot be resolved, the amounts are invalid, or the Lens reports custom accounting. Do not substitute shared PoolManager custody balances, historical swap sums, or estimated values. `tvlUsd` retains its existing availability and calculation behavior.

The frontend will use the API object for V4, format the raw amounts with each token's decimals, and compute the composition bar from the displayed token's value (`displayedAmount × priceInQuote`) versus the other token amount. The bar and quantities will be presented together in the existing Pool balances section. If V4 data is null, show a concise unavailable state instead of the current permanent “not available for V4 pools yet” message. V2/V3 behavior is unchanged.

## API and component changes

- `be/src/pools/stats.ts`: return the reserve values and spot price from the existing Reserves Lens snapshot; keep TVL calculation behavior intact.
- `be/src/api/poolStore.ts`, `be/src/api/schemas.ts`, `be/openapi.json`, and generated `fe/src/api/schema.ts`: expose the nullable `poolBalances` response field.
- `fe/src/api/client.ts`, `fe/src/features/pools/pool-detail.tsx`, `pool-stats.tsx`, and `pool-balances.tsx`: pass and render the API values for V4; retain V2/V3 direct reads.

## Verification

Add backend coverage for a successful Lens result, custom-accounting/unavailable results, and precision-preserving raw strings. Add frontend coverage for rendering V4 balances and the value-weighted bar, plus the unavailable state when the API object is null. Run the relevant backend and frontend tests and schema check after implementation.

## Out of scope

- Changing how V2/V3 reserves are fetched or displayed.
- Showing hook reserves/effective reserves as if they were pool principal.
- Adding per-position liquidity or tick-range breakdowns.
- Changing TVL, price, or other pool statistics semantics.
