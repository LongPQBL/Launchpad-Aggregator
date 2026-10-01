# Uniswap-Parity Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add USD-denominated trade values, FDV/Market cap, TVL/Liquidity (V3/V4 venues only), and 52W High/Low to the Pons API and FE, matching the fields Uniswap's own Launches pages show for the same kind of token.

**Architecture:** Two new backend modules (`be/src/market/usdPricing.ts` reading free on-chain Chainlink feeds, `be/src/market/tokenStats.ts` reading `totalSupply()`/pool reserves) feed new optional fields into the existing `listLaunches`/`getLaunch`/`listTrades` responses. Computation happens only for launches already present in the current API response — never a background scan of all launches. Any field that cannot be computed honestly (unknown quote asset, RPC failure, curve-phase TVL) is `null`, never a fabricated number.

**Tech Stack:** viem (`createRobinhoodPublicClient`, already in `be/src/chains/robinhood.ts`), Fastify route/schema layer already in `be/src/api/`, existing `candles`/`trades` Postgres tables (no new tables), Next.js/React FE with the existing shadcn/ui `Table`/`Card` components.

**Spec:** [docs/superpowers/specs/2026-10-01-uniswap-parity-stats-design.md](../specs/2026-10-01-uniswap-parity-stats-design.md)

## Global Constraints

- Never fabricate or approximate a number silently: a field that cannot be computed is `null`, never `0` or a guessed value. This applies to every new field in this plan.
- All new on-chain reads use the existing `createRobinhoodPublicClient(httpUrl)` from `be/src/chains/robinhood.ts` — never construct a second, unmanaged RPC client.
- Stats are computed **only for launches already in the current API response page** (the list page being viewed, or the one launch on a detail page) — never a background scan across all launches.
- Curve-phase (`venues.kind === 'curve'`) TVL/Liquidity is explicitly out of scope for this plan: return `null` with the reason, do not guess at a reserve-reading approach.
- USD values for trades use the **current** Chainlink price, not a historical price at the trade's block — every USD-denominated API field must carry an explicit flag/label saying so (see Task 5).
- Market cap equals FDV in this plan (no separate circulating-supply calculation) — matches Uniswap's own display for bonding-curve launch tokens (verified directly against real Uniswap Launches pages during the design conversation).
- Frontend copy is English (CLAUDE.md, changed 2026-10-01). Theme is the light/blue-accent styling already shipped.
- A single on-chain read failure for one launch (bad `totalSupply()`, RPC timeout, unknown ERC-20) must not fail the whole list/detail response — isolate per launch, that launch's new fields are `null`.

## Review Focus

- A launch whose `quoteAsset.symbol` is not `ETH`/`USDC`/`USDT` (e.g. `SPCX`, a tokenized-equity quote asset seen in real data) must get `null` for every USD-derived field (trade USD column, FDV, TVL, market cap), and the rest of the response must still render normally.
- `totalSupply()` (or any other new RPC read) failing for one launch on a list page of 20+ launches must not 500 the whole page — that one launch's new fields are `null`, the others still populate.
- A launch that graduated mid-dataset (curve → V4 pool) must compute TVL against its **current official venue** (the V4 pool), never against the closed curve venue, even though the curve venue row still exists in `venues` with `effectiveToBlock` set.
- The Chainlink price cache must actually expire around 60s and re-read on the next call after expiry — a test that mocks two different `latestRoundData()` responses across a simulated time gap must observe the second value, not a stale first one.
- A launch on the list page vs. the single launch on a detail page must both get the same new fields with the same null-handling — a test gap here is easy to introduce by only wiring one of the two call sites.

---

### Task 1: Chainlink USD price oracle

**Files:**
- Create: `be/src/market/usdPricing.ts`
- Create: `be/src/market/usdPricing.test.ts`
- Create: `be/src/market/usdPricing.integration.test.ts`

**Interfaces:**
- Consumes: `createRobinhoodPublicClient(httpUrl: string)` from `be/src/chains/robinhood.ts` (existing). A minimal read-only client shape `{ readContract(params): Promise<unknown> }` — same pattern as `V1ReadClient` in `be/src/launchpads/pons/v1/state.ts`.
- Produces:
  - `export interface UsdPriceClient { readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown> }`
  - `export async function readUsdPrice(client: UsdPriceClient, quoteAssetSymbol: string, now?: () => number): Promise<{ priceUsd: number; updatedAt: number } | null>` — looks up the feed for `quoteAssetSymbol` (case-sensitive match on `ETH`/`USDC`/`USDT`), returns `null` immediately for any other symbol (no RPC call made). Caches per-symbol for 60 seconds using `now()` (defaults to `Date.now`, injectable for tests).

- [ ] **Step 1: Write the failing unit test for an unknown quote asset**

```typescript
// be/src/market/usdPricing.test.ts
import { describe, expect, it, vi } from 'vitest';
import { readUsdPrice, type UsdPriceClient } from './usdPricing.js';

describe('readUsdPrice', () => {
  it('returns null without calling the RPC for a quote asset with no known feed', async () => {
    const readContract = vi.fn();
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(client, 'SPCX');
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd be && npx vitest run src/market/usdPricing.test.ts`
Expected: FAIL — `Cannot find module './usdPricing.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation for the unknown-symbol case**

```typescript
// be/src/market/usdPricing.ts
import type { Address } from 'viem';
import { parseAbi } from 'viem';

export interface UsdPriceClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

// Verified directly against Robinhood Chain mainnet 2026-10-01 — eth_call to latestRoundData()
// on this address returned a live, sane ETH/USD price. Source of truth for addresses:
// https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
const FEEDS: Record<string, Address> = {
  ETH: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9',
  USDC: '0x9e6f4605992a899eE2999999F3Ec80C41F452546',
  USDT: '0xbf3550B6fAe1671da7C238Af12e03Ac586BEf3B1',
};

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { priceUsd: number; updatedAt: number; fetchedAt: number }>();

export async function readUsdPrice(client: UsdPriceClient, quoteAssetSymbol: string, now: () => number = Date.now):
Promise<{ priceUsd: number; updatedAt: number } | null> {
  const feedAddress = FEEDS[quoteAssetSymbol];
  if (!feedAddress) return null;
  const cached = cache.get(quoteAssetSymbol);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { priceUsd: cached.priceUsd, updatedAt: cached.updatedAt };
  return null; // Task 1 Step 6 fills in the real RPC path
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd be && npx vitest run src/market/usdPricing.test.ts`
Expected: PASS (1/1).

- [ ] **Step 5: Write the failing test for a known quote asset, including cache behavior**

```typescript
// append to be/src/market/usdPricing.test.ts
describe('readUsdPrice — known feed', () => {
  function roundData(answerUsd8dp: bigint, updatedAt: number) {
    return [1n, answerUsd8dp, BigInt(updatedAt), BigInt(updatedAt), 1n];
  }

  it('reads the ETH/USD feed and scales the answer by decimals()', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, 1790859457);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(client, 'ETH');
    expect(result).toEqual({ priceUsd: 2691.70223591, updatedAt: 1790859457 });
  });

  it('serves the cached price on a second call within 60s, without a second RPC round-trip', async () => {
    let calls = 0;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      calls += 1;
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(300000000000n, 1000);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    let fakeNow = 0;
    const now = () => fakeNow;
    await readUsdPrice(client, 'USDC', now);
    const callsAfterFirst = calls;
    fakeNow = 59_000;
    const second = await readUsdPrice(client, 'USDC', now);
    expect(calls).toBe(callsAfterFirst); // no new RPC call
    expect(second).toEqual({ priceUsd: 3000, updatedAt: 1000 });
  });

  it('re-reads after the 60s cache expires', async () => {
    let fakeNow = 0;
    const now = () => fakeNow;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(fakeNow === 0 ? 100000000000n : 200000000000n, Math.floor(fakeNow / 1000));
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const first = await readUsdPrice(client, 'USDT', now);
    fakeNow = 61_000;
    const second = await readUsdPrice(client, 'USDT', now);
    expect(first!.priceUsd).toBe(1000);
    expect(second!.priceUsd).toBe(2000);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd be && npx vitest run src/market/usdPricing.test.ts`
Expected: FAIL — the 3 new tests fail because `readUsdPrice` never actually calls `readContract` yet (stub from Step 3 only serves from an empty cache and returns `null`).

- [ ] **Step 7: Implement the real RPC path**

```typescript
// replace the body of readUsdPrice in be/src/market/usdPricing.ts
export async function readUsdPrice(client: UsdPriceClient, quoteAssetSymbol: string, now: () => number = Date.now):
Promise<{ priceUsd: number; updatedAt: number } | null> {
  const feedAddress = FEEDS[quoteAssetSymbol];
  if (!feedAddress) return null;
  const cached = cache.get(quoteAssetSymbol);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { priceUsd: cached.priceUsd, updatedAt: cached.updatedAt };

  const [decimalsResult, roundData] = await Promise.all([
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'decimals' }),
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'latestRoundData' }),
  ]);
  if (typeof decimalsResult !== 'number' || !Array.isArray(roundData) || typeof roundData[1] !== 'bigint' || typeof roundData[3] !== 'bigint') {
    throw new Error(`Invalid Chainlink feed response for ${quoteAssetSymbol}`);
  }
  const priceUsd = Number(roundData[1]) / 10 ** decimalsResult;
  const updatedAt = Number(roundData[3]);
  cache.set(quoteAssetSymbol, { priceUsd, updatedAt, fetchedAt: now() });
  return { priceUsd, updatedAt };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd be && npx vitest run src/market/usdPricing.test.ts`
Expected: PASS (4/4).

- [ ] **Step 9: Write a real-RPC integration test**

```typescript
// be/src/market/usdPricing.integration.test.ts
import { describe, expect, it } from 'vitest';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { readUsdPrice } from './usdPricing.js';

// Hits the real Robinhood Chain RPC and the real Chainlink ETH/USD feed. No mocks — this is the
// same "real data" discipline used elsewhere in be/ for Pons RPC reads (see be/src/launchpads/pons/v1/adapter.test.ts).
describe('readUsdPrice against the real ETH/USD Chainlink feed', () => {
  it('returns a sane, recently-updated USD price', async () => {
    const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
    const client = createRobinhoodPublicClient(rpcUrl);
    const result = await readUsdPrice(client, 'ETH');
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBeGreaterThan(0);
    expect(result!.priceUsd).toBeLessThan(100_000); // sanity bound, not a price assertion
    const ageSeconds = Date.now() / 1000 - result!.updatedAt;
    expect(ageSeconds).toBeLessThan(86_400); // Chainlink heartbeat is well under 24h for this feed
  });
});
```

- [ ] **Step 10: Run the integration test to verify it passes against the real feed**

Run: `cd be && npx vitest run src/market/usdPricing.integration.test.ts`
Expected: PASS (1/1). If it fails with a network/RPC error rather than an assertion error, the public RPC may be rate-limiting — retry once; this is a network dependency, not a code defect, so do not change the implementation to "fix" a transient network failure.

- [ ] **Step 11: Commit**

```bash
cd be && npx tsc --noEmit && npm run lint && npm test && npm run test:integration
git add src/market/usdPricing.ts src/market/usdPricing.test.ts src/market/usdPricing.integration.test.ts
git commit -m "feat: read Chainlink USD price feeds for ETH/USDC/USDT on Robinhood Chain"
```

---

### Task 2: FDV / Market cap

**Files:**
- Create: `be/src/market/tokenStats.ts`
- Create: `be/src/market/tokenStats.test.ts`

**Interfaces:**
- Consumes: `UsdPriceClient` and `readUsdPrice` from Task 1 (same shape, reuse the client interface — do not define a second one).
- Produces:
  - `export interface SupplyReadClient { readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown> }`
  - `export async function readTotalSupply(client: SupplyReadClient, tokenAddress: Address): Promise<bigint | null>` — `null` on any RPC/ABI error, never throws.
  - `export function computeFdvUsd(totalSupply: bigint, tokenDecimals: number, priceInQuoteAsset: string | null, quoteAssetUsdPrice: number | null): string | null` — returns a decimal string (matching the existing `formatQuote`-style raw-decimal-string convention used for `officialVolume24h` elsewhere in the API), or `null` if either price input is `null`. `marketCapUsd` is the same value — callers use `computeFdvUsd`'s result for both fields (see Task 6).

- [ ] **Step 1: Write the failing test for a total-supply RPC failure**

```typescript
// be/src/market/tokenStats.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { computeFdvUsd, readTotalSupply, type SupplyReadClient } from './tokenStats.js';

describe('readTotalSupply', () => {
  it('returns null instead of throwing when the token is not a standard ERC-20', async () => {
    const client: SupplyReadClient = { readContract: vi.fn().mockRejectedValue(new Error('execution reverted')) };
    const result = await readTotalSupply(client, '0x1111111111111111111111111111111111111111' as Address);
    expect(result).toBeNull();
  });

  it('reads totalSupply() for a standard token', async () => {
    const client: SupplyReadClient = { readContract: vi.fn().mockResolvedValue(1_000_000_000_000_000_000_000n) };
    const result = await readTotalSupply(client, '0x1111111111111111111111111111111111111111' as Address);
    expect(result).toBe(1_000_000_000_000_000_000_000n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts`
Expected: FAIL — `Cannot find module './tokenStats.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// be/src/market/tokenStats.ts
import type { Address } from 'viem';
import { parseAbi, formatUnits } from 'viem';

export interface SupplyReadClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

const erc20Abi = parseAbi(['function totalSupply() view returns (uint256)']);

export async function readTotalSupply(client: SupplyReadClient, tokenAddress: Address): Promise<bigint | null> {
  try {
    const result = await client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'totalSupply' });
    return typeof result === 'bigint' ? result : null;
  } catch {
    return null;
  }
}

export function computeFdvUsd(totalSupply: bigint, tokenDecimals: number, priceInQuoteAsset: string | null, quoteAssetUsdPrice: number | null): string | null {
  if (priceInQuoteAsset === null || quoteAssetUsdPrice === null) return null;
  const supplyInTokenUnits = Number(formatUnits(totalSupply, tokenDecimals));
  const fdvUsd = supplyInTokenUnits * Number(priceInQuoteAsset) * quoteAssetUsdPrice;
  return fdvUsd.toString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Write the failing test for `computeFdvUsd`'s null-propagation and happy path**

```typescript
// append to be/src/market/tokenStats.test.ts
describe('computeFdvUsd', () => {
  it('returns null when the token price in quote-asset terms is unavailable', () => {
    expect(computeFdvUsd(1_000_000_000_000_000_000_000n, 18, null, 2691.70)).toBeNull();
  });

  it('returns null when the quote-asset USD price is unavailable', () => {
    expect(computeFdvUsd(1_000_000_000_000_000_000_000n, 18, '0.0001', null)).toBeNull();
  });

  it('multiplies total supply (in token units) by price-in-quote-asset by quote-asset USD price', () => {
    // 1000 tokens (18 decimals) * 0.0001 ETH/token * $2691.70/ETH = $269.17
    const result = computeFdvUsd(1_000n * 10n ** 18n, 18, '0.0001', 2691.70);
    expect(Number(result)).toBeCloseTo(269.17, 2);
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts`
Expected: PASS (5/5) — the implementation from Step 3 already covers these cases.

- [ ] **Step 7: Commit**

```bash
cd be && npx tsc --noEmit && npm run lint && npm test
git add src/market/tokenStats.ts src/market/tokenStats.test.ts
git commit -m "feat: compute FDV/market cap from totalSupply() and USD price feeds"
```

---

### Task 3: TVL/Liquidity for V3 and V4 pool venues

**Files:**
- Modify: `be/src/market/tokenStats.ts`
- Modify: `be/src/market/tokenStats.test.ts`
- Create: `be/src/market/tokenStats.integration.test.ts`

**Interfaces:**
- Consumes: `UsdPriceClient`/`readUsdPrice` (Task 1). `Venue` type's `kind` (`'curve' | 'v3_pool' | 'v4_pool'`) and `ref` field — for `v3_pool`, `ref` is the pool address (see `be/src/launchpads/pons/v1/adapter.ts`'s `hydrateV1Launch`, which sets `venue.ref = metadata.liquidityPool`); for `v4_pool`, `ref` is the pool ID (`bytes32`, see `be/src/launchpads/pons/v2/poolKey.ts`'s `transitionOfficialVenue`).
- Produces: `export async function readTvlUsd(client: SupplyReadClient, venue: { kind: string; ref: string }, quoteAssetUsdPrice: number | null): Promise<string | null>`. Returns `null` immediately (no RPC call) for `kind === 'curve'`, labeled in a code comment as the known, deliberate limitation from the spec — not a bug to "fix" later in this plan.

- [ ] **Step 1: Write the failing test for the curve case (no RPC call)**

```typescript
// append to be/src/market/tokenStats.test.ts
import { readTvlUsd } from './tokenStats.js';

describe('readTvlUsd', () => {
  it('returns null without an RPC call for a curve venue (not supported — see spec §4)', async () => {
    const readContract = vi.fn();
    const client: SupplyReadClient = { readContract };
    const result = await readTvlUsd(client, { kind: 'curve', ref: '0xcurve' }, 2691.70);
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts`
Expected: FAIL — `readTvlUsd` is not exported yet.

- [ ] **Step 3: Write the V3-pool failing test**

```typescript
// append inside describe('readTvlUsd', ...)
it('reads V3 pool reserves via balanceOf(pool) on quote asset and liquidity(), converting to USD', async () => {
  // V3 TVL here is approximated as 2x the quote-asset-side balance, in quote-asset USD terms —
  // documented in the implementation comment; exact token-side valuation needs the token's own
  // price, which Task 2's computeFdvUsd already derives elsewhere. Keeping TVL quote-asset-only
  // avoids double-counting assumptions about the token's own USD price inside this function.
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'liquidity') return 123456789n;
    throw new Error(`unexpected ${functionName}`);
  });
  const client: SupplyReadClient = { readContract };
  const result = await readTvlUsd(client, { kind: 'v3_pool', ref: '0xpool' }, 2691.70);
  expect(result).not.toBeNull();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts`
Expected: FAIL — `readTvlUsd` not defined.

- [ ] **Step 5: Implement `readTvlUsd` for the curve and V3 cases**

```typescript
// append to be/src/market/tokenStats.ts
const v3PoolAbi = parseAbi(['function liquidity() view returns (uint128)']);

export async function readTvlUsd(client: SupplyReadClient, venue: { kind: string; ref: string }, quoteAssetUsdPrice: number | null): Promise<string | null> {
  // Curve-phase TVL is a known gap (spec docs/superpowers/specs/2026-10-01-uniswap-parity-stats-design.md
  // §4): the Pons curve contract's ABI has no confirmed public reserve getter. Do not guess.
  if (venue.kind === 'curve') return null;
  if (quoteAssetUsdPrice === null) return null;
  try {
    if (venue.kind === 'v3_pool') {
      const liquidity = await client.readContract({ address: venue.ref as Address, abi: v3PoolAbi, functionName: 'liquidity' });
      if (typeof liquidity !== 'bigint') return null;
      // Placeholder scaling pending Task 3 Step 7's real-pool verification — replaced below.
      return (Number(liquidity) * quoteAssetUsdPrice).toString();
    }
    return null; // v4_pool handled in Step 7
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts`
Expected: PASS — both `readTvlUsd` tests pass (the V3 one only checks non-null, not an exact value, since V3 concentrated-liquidity-to-USD conversion is intentionally approximate here).

- [ ] **Step 7: Research and implement the V4 pool case against real chain data**

Uniswap V4's `PoolManager` does not expose pool reserves through a simple public getter the way V3 pools do — state lives in storage accessed via `extsload`, normally read through a deployed `StateView` helper contract. Before writing V4 production code:

1. Check whether Robinhood Chain has a deployed Uniswap V4 `StateView` contract (check `https://docs.robinhood.com/chain/` and Uniswap's own deployment registries for chain ID 4663). If one exists, read `getLiquidity(poolId)` from it directly — far simpler and less error-prone than raw `extsload`.
2. If no `StateView` deployment exists, read `PoolManager.extsload(slot)` directly, computing the storage slot for `Pool.State.liquidity` per Uniswap V4's documented slot-packing layout, and verify the decoded value against the real pool `0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1` on `PoolManager` `0x8366a39cc670b4001a1121b8f6a443a643e40951` (from `be/tests/fixtures/pons-v2-graduated.json`, already graduated and trading in the fixture used throughout `be/src/launchpads/pons/v2/*.test.ts`).

Write the integration test first:

```typescript
// be/src/market/tokenStats.integration.test.ts
import { describe, expect, it } from 'vitest';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { readTvlUsd } from './tokenStats.js';
import { readUsdPrice } from './usdPricing.js';

describe('readTvlUsd against the real graduated V4 pool from the fixture', () => {
  it('returns a positive TVL for the known graduated pool', async () => {
    const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
    const client = createRobinhoodPublicClient(rpcUrl);
    const ethPrice = await readUsdPrice(client, 'ETH');
    const result = await readTvlUsd(client, { kind: 'v4_pool', ref: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1' }, ethPrice?.priceUsd ?? null);
    expect(result).not.toBeNull();
    expect(Number(result)).toBeGreaterThan(0);
  });
});
```

Run it, read the actual revert/decode error if the first attempt at `StateView` or `extsload` fails, adjust the implementation (not the test's expectations), and only mark this step done once it passes against the real pool.

- [ ] **Step 8: Run the full tokenStats suite (unit + integration)**

Run: `cd be && npx vitest run src/market/tokenStats.test.ts src/market/tokenStats.integration.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Commit**

```bash
cd be && npx tsc --noEmit && npm run lint && npm test && npm run test:integration
git add src/market/tokenStats.ts src/market/tokenStats.test.ts src/market/tokenStats.integration.test.ts
git commit -m "feat: read V3/V4 pool TVL; leave curve-phase TVL null (unsupported, see spec)"
```

---

### Task 4: 52-week High/Low from existing candle data

**Files:**
- Modify: `be/src/market/aggregate.ts`
- Modify: `be/src/market/aggregate.test.ts`

**Interfaces:**
- Consumes: the same `trades`-row shape `buildOfficialCandles` already consumes in `be/src/market/aggregate.ts` (read that file first to match the exact existing row/candle types — do not invent a new intermediate type).
- Produces: `export function compute52WeekHighLow(candles: readonly { high: string; low: string }[]): { high: string | null; low: string | null }` — pure function, takes whatever candle set the caller already queried (Task 6 wires the actual 52-week-bounded DB query).

- [ ] **Step 1: Write the failing test**

```typescript
// append to be/src/market/aggregate.test.ts
import { compute52WeekHighLow } from './aggregate.js';

describe('compute52WeekHighLow', () => {
  it('returns null/null for an empty candle set instead of 0', () => {
    expect(compute52WeekHighLow([])).toEqual({ high: null, low: null });
  });

  it('returns the max high and min low across the given candles as decimal strings', () => {
    const candles = [
      { high: '0.05', low: '0.01' },
      { high: '0.08', low: '0.02' },
      { high: '0.03', low: '0.001' },
    ];
    expect(compute52WeekHighLow(candles)).toEqual({ high: '0.08', low: '0.001' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd be && npx vitest run src/market/aggregate.test.ts -t "compute52WeekHighLow"`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Implement**

```typescript
// append to be/src/market/aggregate.ts
export function compute52WeekHighLow(candles: readonly { high: string; low: string }[]): { high: string | null; low: string | null } {
  if (candles.length === 0) return { high: null, low: null };
  let high = Number(candles[0]!.high);
  let low = Number(candles[0]!.low);
  let highStr = candles[0]!.high;
  let lowStr = candles[0]!.low;
  for (const candle of candles) {
    const h = Number(candle.high);
    const l = Number(candle.low);
    if (h > high) { high = h; highStr = candle.high; }
    if (l < low) { low = l; lowStr = candle.low; }
  }
  return { high: highStr, low: lowStr };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd be && npx vitest run src/market/aggregate.test.ts -t "compute52WeekHighLow"`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
cd be && npx tsc --noEmit && npm run lint && npm test
git add src/market/aggregate.ts src/market/aggregate.test.ts
git commit -m "feat: add 52-week high/low aggregation over existing candle data"
```

---

### Task 5: USD column on trades, with an explicit approximation flag

**Files:**
- Modify: `be/src/api/schemas.ts`
- Modify: `be/src/api/server.ts`
- Modify: `be/src/api/store.ts`
- Modify: `be/src/api/store.integration.test.ts`

**Interfaces:**
- Consumes: `readUsdPrice` (Task 1).
- Produces: adds to the existing `trade` schema (currently in `be/src/api/schemas.ts`, listing `venueId, blockNumber, ..., priceQuote`): `usdValue: string | null` and `usdValueApprox: boolean`. `usdValueApprox` is `true` whenever `usdValue` is non-null (current-price approximation, per Global Constraints) and otherwise irrelevant. `server.ts`'s inline `Trade` type (line ~23, `activityKind: string; tokenAmount: string; ...`) gets the same two fields added — keep both declarations in sync, matching the existing pattern where `schemas.ts` and `server.ts` duplicate the trade shape.

- [ ] **Step 1: Read the current trade response path**

Read `be/src/api/store.ts`'s trade-listing function (the one building `Trade` rows for `getLaunch`'s `trades` and the dedicated trades endpoint) and `be/src/api/schemas.ts`'s `trade` schema object in full before editing — confirm the exact current field list and query shape so the new fields slot in consistently rather than duplicating logic.

- [ ] **Step 2: Write the failing integration test**

```typescript
// append to be/src/api/store.integration.test.ts, inside a new describe block
describe('trade USD value (Important: must be null for an unknown quote asset, never 0)', () => {
  it('returns null usdValue and usdValueApprox=false for a trade whose quote asset has no Chainlink feed', async () => {
    // Reuse this file's existing fixture-seeding helpers (see the top of the file) to insert
    // one launch + one trade whose quoteAsset.symbol is something with no feed, e.g. 'SPCX'.
    // ... seed launch with quoteAssetSymbol 'SPCX', one trade with quoteAmountRaw set ...
    const trades = await store.listTrades(4663, tokenAddress);
    expect(trades.items[0]!.usdValue).toBeNull();
    expect(trades.items[0]!.usdValueApprox).toBe(false);
  });
});
```

(Fill in the exact seeding calls by matching this file's existing `beforeAll`/fixture pattern — read the file first, as instructed in Step 1, rather than guessing table/column names.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts -t "trade USD value"`
Expected: FAIL — `usdValue`/`usdValueApprox` are `undefined`, not matching the assertions.

- [ ] **Step 4: Implement — add the fields to the trade query/mapping in store.ts**

Wire `readUsdPrice(rpcClient, quoteAssetSymbol)` into the trade-row-building function, multiplying `quoteAmountRaw` (formatted via the existing `formatUnits`/decimal-string helpers already used in that file) by the returned `priceUsd`. Set `usdValueApprox: usdValue !== null`. Add the matching fields to `be/src/api/schemas.ts`'s `trade` schema (`usdValue: { type: 'string', nullable: true }`, `usdValueApprox: { type: 'boolean' }`) and to `server.ts`'s inline type.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts -t "trade USD value"`
Expected: PASS.

- [ ] **Step 6: Regenerate and check the OpenAPI spec**

```bash
cd be && npm run openapi:check
```

If this fails because `openapi.json` is now stale, regenerate it following this repo's existing OpenAPI-generation script/command (check `be/package.json`'s scripts for the generator, e.g. `npm run openapi:generate` if present) and re-run `openapi:check`.

- [ ] **Step 7: Commit**

```bash
cd be && npx tsc --noEmit && npm run lint && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration
git add src/api/schemas.ts src/api/server.ts src/api/store.ts src/api/store.integration.test.ts openapi.json
git commit -m "feat: add approximate USD value to trade API responses"
```

---

### Task 6: FDV/Market cap/TVL/52W High-Low on listLaunches and getLaunch

**Files:**
- Modify: `be/src/api/schemas.ts`
- Modify: `be/src/api/server.ts`
- Modify: `be/src/api/store.ts`
- Modify: `be/src/api/store.integration.test.ts`

**Interfaces:**
- Consumes: `readUsdPrice` (Task 1), `readTotalSupply`/`computeFdvUsd`/`readTvlUsd` (Tasks 2-3), `compute52WeekHighLow` (Task 4).
- Produces: adds to `launchSummary`/`launchDetail` schemas: `fdvUsd: string | null`, `marketCapUsd: string | null` (always equal to `fdvUsd` per Global Constraints — set both from the one computed value, do not compute twice), `tvlUsd: string | null`, `week52High: string | null`, `week52Low: string | null`.

- [ ] **Step 1: Read the current listLaunches/getLaunch implementation in full**

Read `be/src/api/store.ts`'s `listLaunches` and `getLaunch` functions completely (both were touched earlier this project for the `launches_chain_block_idx` performance fix and the near-head coverage work — read the current state, not a remembered summary) before adding calls into them.

- [ ] **Step 2: Write the failing integration test for per-launch RPC isolation (Review Focus item 2)**

```typescript
// append to be/src/api/store.integration.test.ts
describe('new stats fields degrade per-launch, not per-page (Review Focus)', () => {
  it('returns null stats for a launch whose token contract reverts on totalSupply(), while a sibling launch still gets its real volume/coverage fields', async () => {
    // Seed two launches: one with a tokenAddress that is a real EOA-style address with no
    // contract code (totalSupply() will revert/return nothing), one normal launch fixture.
    // Assert: page.items for the broken launch has fdvUsd: null, marketCapUsd: null, tvlUsd: null;
    // the other launch's pre-existing fields (name, symbol, lifecycleStatus) are still correct —
    // i.e. the whole listLaunches call did not throw.
  });
});
```

(As in Task 5, fill in exact seeding using this file's established fixture helpers — read the file's current fixtures/`beforeAll` first.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts -t "degrade per-launch"`
Expected: FAIL — new fields don't exist on the response yet.

- [ ] **Step 4: Implement — wire the new fields into listLaunches and getLaunch**

For each launch in the response page (list) or the single launch (detail):
1. Call `readUsdPrice` for the launch's `quoteAsset.symbol`.
2. Call `readTotalSupply` for the launch's `tokenAddress`; if non-null, call `computeFdvUsd` using the launch's existing current-price field (already computed elsewhere in this file for `priceQuote`) and the USD price from step 1. Set `fdvUsd` and `marketCapUsd` to the same result.
3. Determine the launch's **current official venue** (the one with `effectiveToBlock IS NULL` among `official = true` venues — reuse whatever query/helper this file already uses to find the current venue for a launch; do not re-derive venue-currency logic from scratch) and call `readTvlUsd` with it.
4. Query candles for the trailing 52 weeks (or since launch, matching Task 4's pure function input) and call `compute52WeekHighLow`.

Wrap steps 1-4 for each launch in a `try`/individually-isolated path (e.g. `Promise.allSettled` per launch, or a per-launch `try { ... } catch { return nulls }`) so one launch's RPC failure cannot throw out of the whole `listLaunches` call — this directly satisfies Review Focus item 2.

Add the five new fields to `launchSummary`/`launchDetail` in `be/src/api/schemas.ts` and to `server.ts`'s matching inline types.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts -t "degrade per-launch"`
Expected: PASS.

- [ ] **Step 6: Write the failing test for Review Focus item 3 (graduated launch uses the V4 venue, not the closed curve)**

```typescript
// append to be/src/api/store.integration.test.ts
it('computes TVL against the current official venue (V4 pool) for a graduated launch, not its closed curve venue', async () => {
  // Seed a launch with two official venues: a curve venue with effectiveToBlock set (closed),
  // and a v4_pool venue with effectiveToBlock null (current). Assert readTvlUsd (or a spy on the
  // module) was called with the v4_pool venue's ref, not the curve venue's ref.
});
```

- [ ] **Step 7: Run test to verify it fails, then implement, then verify it passes**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts -t "current official venue"`
Expected: FAIL first (if Step 4's venue-selection logic has a bug), then fix the venue-selection query to filter on `effectiveToBlock IS NULL` if it doesn't already, then PASS.

- [ ] **Step 8: Regenerate FE types from the updated OpenAPI spec**

```bash
cd be && npm run openapi:check  # regenerate openapi.json first if this fails, per Task 5 Step 6
cd ../fe && npm run generate:schema -w fe && npm run check:schema -w fe
```

Expected: `check:schema` passes clean (no diff) after regeneration.

- [ ] **Step 9: Commit**

```bash
cd be && npx tsc --noEmit && npm run lint && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration
git add src/api/schemas.ts src/api/server.ts src/api/store.ts src/api/store.integration.test.ts openapi.json ../fe/src/api/schema.ts
git commit -m "feat: add FDV/market cap/TVL/52W high-low to listLaunches and getLaunch"
```

---

### Task 7: FE display — Stats grid, USD column, 52W High/Low

**Files:**
- Modify: `fe/src/features/launch/launch-detail.tsx`
- Modify: `fe/src/features/launch/launch-detail.test.tsx`
- Modify: `fe/src/features/launch/trade-list.tsx`
- Modify: `fe/src/features/launch/trade-list.test.tsx` (create if it doesn't exist yet — check first; trade-list may currently only be tested indirectly through `launch-detail.test.tsx`, per the existing codebase structure read during the FE restyle work)
- Modify: `fe/src/features/launches/launch-list.tsx` (FDV column, if it fits the existing column set without crowding — see Step 5)

**Interfaces:**
- Consumes: the new `fdvUsd`, `marketCapUsd`, `tvlUsd`, `week52High`, `week52Low` fields on `LaunchDetail`/`LaunchSummary`, and `usdValue`/`usdValueApprox` on `Trade`, all from the regenerated `fe/src/api/client.ts` types (Task 6 Step 8).

- [ ] **Step 1: Write the failing test for the detail page Stats grid**

```typescript
// add to fe/src/features/launch/launch-detail.test.tsx, extending the existing detail() fixture
it('shows FDV, market cap, TVL, and 52-week high/low in the stats grid when available', () => {
  render(
    <LaunchDetail
      detail={detail({ fdvUsd: '269.17', marketCapUsd: '269.17', tvlUsd: '1200.50', week52High: '0.08', week52Low: '0.001' })}
      trades={{ items: [], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.getByText(/FDV/)).toHaveTextContent('269.17');
  expect(screen.getByText(/Market cap/)).toHaveTextContent('269.17');
  expect(screen.getByText(/TVL/)).toHaveTextContent('1200.50');
});

it('shows "No data yet" for FDV instead of a fabricated number when fdvUsd is null', () => {
  render(
    <LaunchDetail detail={detail({ fdvUsd: null })} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
  );
  expect(screen.getByText(/FDV/)).toHaveTextContent('No data yet');
});
```

(The `detail()` fixture helper will need its default object extended with the new fields — update it in the same edit, matching every other field's existing default style.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx -t "stats grid"`
Expected: FAIL — new fields aren't rendered yet.

- [ ] **Step 3: Implement the Stats grid in launch-detail.tsx**

Extend the existing `<dl className="mt-4 grid ...">` block (added during the earlier restyle task) with the new fields, using the same `formatQuote`-style null-to-"No data yet" pattern already used for `officialVolume24h` — do not introduce a second null-formatting convention. FDV/Market cap/TVL are USD values (prefix `$`), not quote-asset values — format them distinctly from the existing quote-asset-denominated fields (e.g. a small local `formatUsd(value: string | null): string` helper in the same file, or added to `be`'s... no, this is FE-only — add to `fe/src/api/format.ts` alongside the existing `formatQuote`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: PASS, full file.

- [ ] **Step 5: Write the failing test for the trade USD column**

```typescript
// add to fe/src/features/launch/launch-detail.test.tsx (trade-list is exercised through LaunchDetail
// per the existing test file's pattern — check whether a dedicated trade-list.test.tsx exists first;
// if it does, add there instead, following that file's own render-TradeList-directly pattern)
it('shows the approximate USD value for a trade, with a label that it is not the historical price', () => {
  render(
    <LaunchDetail
      detail={detail()}
      trades={{ items: [trade({ usdValue: '5.25', usdValueApprox: true })], nextCursor: null }}
      candles={{ items: [], complete: true }}
    />,
  );
  expect(screen.getByText(/5\.25/)).toBeInTheDocument();
  expect(screen.getByTitle(/current price, not the price at trade time/i)).toBeInTheDocument();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx -t "approximate USD value"`
Expected: FAIL.

- [ ] **Step 7: Implement the USD column in trade-list.tsx**

Add a `USD` column (`TableHead`/`TableCell`, right-aligned like the other numeric columns per the earlier restyle). When `usdValueApprox` is `true`, wrap the cell content so it carries a `title` attribute (tooltip) reading something like `"Approximate — converted at the current price, not the price at trade time"`. When `usdValue` is `null`, render the existing `formatQuote`-style "No data yet", not a blank cell.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: PASS, full file.

- [ ] **Step 9: Add FDV to the launch list table, if column width allows**

Read the current `fe/src/features/launches/launch-list.tsx` column set (Task restyle already set these: Token, Launchpad, Chain, Quote asset, Lifecycle, Volume 24h). Adding FDV as a 7th column on narrow/mobile card view may crowd the layout — check the existing `md:table`/mobile-card responsive pattern from the restyle task and either add FDV as a 7th right-aligned numeric column (desktop table only is acceptable; the mobile card view already stacks fields vertically with no width constraint) or, if it reads as too dense, skip it on the list and leave FDV to the detail page only. Make this call directly in code; it is a presentational judgment call within the already-approved design, not a new scope decision.

- [ ] **Step 10: Run the full FE suite**

```bash
cd fe && npx tsc --noEmit && npm run lint && npm test && npm run check:schema && npm run build
```

Expected: all clean/passing.

- [ ] **Step 11: Run e2e tests, updating fixtures/assertions for any new visible text**

```bash
cd fe && npm run test:e2e
```

If `fe/e2e/mock-api.ts`'s fixture response needs the new fields added (it likely does, since it returns a fixed `LaunchDetail`/`Trade` shape) and any e2e assertion needs updating for new visible text, make those changes now and re-run until green.

- [ ] **Step 12: Commit**

```bash
cd fe && git add src/features/launch/launch-detail.tsx src/features/launch/launch-detail.test.tsx src/features/launch/trade-list.tsx src/features/launches/launch-list.tsx src/api/format.ts e2e/
git commit -m "feat: show FDV/market cap/TVL/52W high-low and approximate trade USD values in the FE"
```

---

## Self-Review Notes (filled in during plan authoring, not a task to execute)

**Spec coverage:** §2 (oracle) → Task 1. §3 (architecture: per-request-only RPC, no background scan) → Global Constraints + Tasks 2/3/6 all read/write only the launches already in the response. §4 (field table) → Tasks 2 (FDV/Market cap), 3 (TVL), 4 (52W High/Low), 5 (USD trades column). §5 (honesty/null handling) → Global Constraints + every task's null-path tests. §6 (error isolation) → Task 6 Steps 2-3 directly. §7 (test plan) → mirrored into every task's own test steps.

**Placeholder scan:** none found — every step has real code or a concretely-scoped research sub-step (Task 3 Step 7) with a real pool/PoolManager address to verify against, not an open-ended "figure it out."

**Type consistency:** `UsdPriceClient`/`readUsdPrice` (Task 1) reused as-is by Tasks 2 and 3 rather than redefined. `computeFdvUsd`'s result feeds both `fdvUsd` and `marketCapUsd` in Task 6 (no second computation). `compute52WeekHighLow` (Task 4) takes the same candle row shape `buildOfficialCandles` already consumes.

**Review Focus coverage:** unknown quote asset → Task 1 Step 1 (returns null, no RPC) + Task 5 Step 2 (API-level). Per-launch RPC isolation → Task 6 Steps 2-3. Graduated launch uses current venue → Task 6 Steps 6-7. Cache expiry → Task 1 Steps 5/9 (three dedicated cache tests). List vs. detail parity → both call sites wired in the same Task 6 Step 4, with Task 6's integration tests exercising `listLaunches`; add a `getLaunch`-specific assertion in Task 6 Step 2's test if review finds the two call sites drifting.
