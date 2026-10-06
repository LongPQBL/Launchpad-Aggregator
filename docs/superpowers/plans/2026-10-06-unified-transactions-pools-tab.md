# Unified Transactions/Pools Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the launch detail page's two stacked sections (official-only `TradeList` + a separate "Other pools" list) with a single Transactions/Pools tab switcher, where Transactions is a true time-merged feed of official trades and other pools' swaps for the same token, styled per the user's reference screenshot, with corrected rounding rules and an opt-in dark theme.

**Architecture:** One new backend endpoint (`GET /v1/launches/:chainId/:tokenAddress/transactions`) does a single SQL `UNION ALL` across the existing `trades` and `pool_trades` tables (excluding any pool already counted as an official venue, to avoid double-counting a swap), returns one correctly-ordered, cursor-paginated page, and reuses the existing USD valuation/backfill machinery. The frontend gets a new `transaction-list.tsx` table component, a hand-rolled `Tabs` UI primitive (no new dependency — this repo's `ui/` components are plain CVA wrappers, not Radix), two small rounding-rule fixes in `format.ts`, and an additive light/dark theme toggle.

**Tech Stack:** Fastify + `pg` + Drizzle schema (read-only raw SQL here, matching this file's existing style) on the backend; Next.js App Router + React + Tailwind v4 + Vitest/Testing Library on the frontend.

**Spec:** `docs/superpowers/specs/2026-10-06-unified-transactions-pools-tab-design.md`

## Global Constraints

- Never convert missing/unavailable data to a fabricated zero or silently-complete value (project-wide rule; see `be/src/api/store.ts`'s existing `usdValueStatus: 'pending'|'unavailable'` handling).
- Preserve exact `(blockNumber, logIndex)` / `(blockNumber, txHash, logIndex)` ordering — never re-sort by insertion time or approximate time.
- Do not double-count a swap: a pool that is also an official venue must be excluded from the "pool" branch of the new endpoint.
- `formatUsd()` (FDV/TVL/market cap, used elsewhere) must NOT change behavior — only `formatAmount()` (new) and `formatPrice()` change.
- Default theme stays light (existing CLAUDE.md decision); dark is opt-in via toggle, not a default-behavior change.
- Work directly on `main`, no worktree, no multi-agent split (solo-dev repo convention). Commit after each task.
- FE copy stays in English; this plan's own prose and code comments follow the existing file's language (English in `.ts`/`.tsx`, this plan document in English since plans aren't user-facing docs).

## Review Focus

- A token with **zero other pools** (the common case today) must render identically to today's official-only trade list — the UNION's pool branch returning 0 rows must not break pagination or ordering. (Covered: Task 1 integration test "token with no other pools".)
- A pool that **is** the official venue (Pons-graduated V4 pool) must never appear twice (once via `trades`, once via `pool_trades`) in the merged feed. (Covered: Task 1 integration test "excludes official-designated pool from the pool branch".)
- A trade/swap whose quote asset has **no verified USD feed** must show `usdValueStatus: 'unavailable'`, never `null` silently treated as `0`. (Covered: Task 1 integration test, mirrors existing `listTrades` coverage.)
- `formatPrice()` must still show exactly 2 decimals for a price **at or above 1 unit** (e.g. `1459.0671` → `1459.07`), not 3 — the fix only changes the sub-1 branch. (Covered: Task 4, existing test at `format.test.ts:71-73` must keep passing unchanged.)
- The merged feed's pagination cursor must produce a **stable, non-overlapping, non-skipping** sequence across multiple pages when official and pool rows interleave in time. (Covered: Task 1 integration test "paginates a merged page boundary across sources".)

---

## Task 1: Backend — `listTransactions` merged query

**Files:**
- Modify: `be/src/api/store.ts` (add `listTransactions`, thread `rpcClient` into `createApiStore`)
- Modify: `be/src/api/server.ts` (add `TransactionResponse` type, add `listTransactions` to `ApiDeps['data']`)
- Modify: `be/src/cli/api.ts:15` (pass `rpcClient` to `createApiStore`)
- Test: `be/src/api/store.integration.test.ts` (new `describe('listTransactions', ...)` block)

**Interfaces:**
- Consumes: `assetDecimals(client: UsdPriceClient | undefined, address: string): Promise<number | null>` from `be/src/pools/stats.ts`; `valueTradeUsd(pool, chainId, quoteAssetAddress, trade): Promise<TradeUsdValuation>` from `be/src/market/quotePricing/tradeValuation.ts`; `resolveVerifiedFeed(pool, chainId, quoteAssetAddress): Promise<QuoteFeed | null>` from `be/src/market/quotePricing/feedRegistry.js`; `enqueueRoundBackfillJob(pool, chainId, feedAddress, rangeStart, rangeEnd): Promise<void>` from `be/src/market/quotePricing/priceJobStore.js`; `encodeCursor`/`decodeCursor` from `be/src/api/cursor.js`; existing `Row = Record<string, unknown>`, `string()`, `number()`, `nullableString()` helpers already in `store.ts`.
- Produces: `export interface TransactionResponse { source: 'official' | 'pool'; venueId: string | null; pool: { protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string } | null; blockNumber: string; txHash: string; logIndex: number; timestamp: number; side: 'buy' | 'sell'; activityKind: string | null; tokenAmount: string | null; quoteAmount: string | null; quoteAssetAddress: string | null; traderAddress: string; usdValue: string | null; usdValueApprox: boolean; usdValueStatus: 'priced' | 'pending' | 'unavailable' }` (in `server.ts`), and `data.listTransactions(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TransactionResponse>>` for Task 2's route to call.

- [ ] **Step 1: Write the failing integration test — no other pools (regression baseline)**

Add to `be/src/api/store.integration.test.ts`, near the existing `listTrades` tests (reuse the file's existing `seed`/fixture helpers where possible; this block adds its own token/venue/trade fixture to stay independent):

```ts
describe('listTransactions', () => {
  const txToken = '0x1616161616161616161616161616161616161616';
  const txSource = 'store-test-transactions';
  const txVenueId = `pons-v2-curve:${txToken}`;
  const officialTxHash = '0x' + 'c'.repeat(64);

  async function seedOfficialOnly() {
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,4663,'v2',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [txSource, txToken]);
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,NULL,'TxTest','TXT',18,'pons','v2',$1,$1,1,$3,0,$1,'ROBIN',18,'trading') ON CONFLICT DO NOTHING`,
    [txToken, txSource, officialTxHash]);
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,'curve',$2,$3,NULL,1,true) ON CONFLICT (id) DO NOTHING`,
    [txVenueId, txToken, txSource]);
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,timestamp,
      side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,trader_address)
      VALUES (4663,$1,$2,1,$3,$4,0,1700000000,'buy','1000000000000000000','2000000000000000000',$1,'CurveBuy','user_trade',$1)
      ON CONFLICT DO NOTHING`,
    [txToken, txVenueId, blockHash, officialTxHash]);
  }

  afterEach(async () => {
    await pool.query('DELETE FROM trades WHERE token_address = $1', [txToken]);
    await pool.query('DELETE FROM pool_trades WHERE chain_id = 4663 AND trader_address = $1', [txToken]);
    await pool.query('DELETE FROM pool_members WHERE chain_id = 4663 AND token_address = $1', [txToken]);
    await pool.query('DELETE FROM pool_catalog WHERE chain_id = 4663 AND currency0 = $1 OR currency1 = $1', [txToken]);
    await pool.query('DELETE FROM venues WHERE token_address = $1', [txToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [txToken]);
    await pool.query('DELETE FROM sources WHERE id = $1', [txSource]);
  });

  it('returns only official trades for a token with no other pools, same shape as listTrades', async () => {
    await seedOfficialOnly();
    const page = await store.listTransactions(4663, txToken, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ source: 'official', venueId: txVenueId, pool: null,
      side: 'buy', tokenAmount: '1', quoteAmount: '2', usdValueStatus: 'unavailable' });
    expect(page.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w be -- store.integration.test.ts -t listTransactions`
Expected: FAIL with `store.listTransactions is not a function`

- [ ] **Step 3: Add `TransactionResponse` and the `listTransactions` signature to `ApiDeps`**

In `be/src/api/server.ts`, after the existing `TradeResponse` interface (around line 41), add:

```ts
export interface TransactionResponse {
  source: 'official' | 'pool';
  venueId: string | null;
  pool: { protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string } | null;
  blockNumber: string; txHash: string; logIndex: number; timestamp: number;
  side: 'buy' | 'sell'; activityKind: string | null;
  tokenAmount: string | null; quoteAmount: string | null; quoteAssetAddress: string | null;
  traderAddress: string;
  usdValue: string | null; usdValueApprox: boolean; usdValueStatus: 'priced' | 'pending' | 'unavailable';
}
```

In the same file's `ApiDeps['data']` interface (around line 81, next to `listTrades`), add:

```ts
    listTransactions(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TransactionResponse>>;
```

- [ ] **Step 4: Implement `listTransactions` in `store.ts`**

Add these imports at the top of `be/src/api/store.ts` (alongside the existing import block):

```ts
import { assetDecimals } from '../pools/stats.js';
```

Add `TransactionResponse` to the existing type-only import from `./server.js` (the line already importing `TradeResponse` etc.).

Add this function inside the object returned by `createApiStore` (same object literal that already has `listTrades`, `listCandles`, etc.) — place it directly after `listTrades`:

```ts
    async listTransactions(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TransactionResponse>> {
      const token = tokenAddress.toLowerCase();
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const result = await pool.query(`
        WITH merged AS (
          SELECT 'official' AS source, t.venue_id, NULL::text AS protocol, NULL::text AS pool_id,
            t.tx_hash, t.log_index, t.block_number, t.timestamp, t.side, t.activity_kind,
            t.token_amount_raw AS amount_a_raw, t.quote_amount_raw AS amount_b_raw, t.trader_address,
            l.quote_asset_address, l.quote_asset_decimals, l.token_decimals
          FROM trades t
          JOIN venues v ON v.id = t.venue_id
          JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true

          UNION ALL

          SELECT 'pool' AS source, NULL::text AS venue_id, pt.protocol, pt.pool_id,
            pt.tx_hash, pt.log_index, pt.block_number, pt.timestamp, NULL::text AS side, NULL::text AS activity_kind,
            pt.amount0_raw AS amount_a_raw, pt.amount1_raw AS amount_b_raw, pt.trader_address,
            NULL::text AS quote_asset_address, NULL::integer AS quote_asset_decimals, NULL::integer AS token_decimals
          FROM pool_trades pt
          JOIN pool_catalog pc ON pc.chain_id = pt.chain_id AND pc.protocol = pt.protocol AND pc.pool_id = pt.pool_id
          WHERE pc.verified = true
            AND EXISTS (SELECT 1 FROM pool_members m WHERE m.chain_id = pc.chain_id AND m.protocol = pc.protocol
              AND m.pool_id = pc.pool_id AND m.token_address = $2)
            AND NOT EXISTS (SELECT 1 FROM venues ov WHERE ov.chain_id = pc.chain_id
              AND ov.kind IN ('v4_pool','v3_pool') AND ov.ref = pc.pool_id AND ov.official = true)
        )
        SELECT * FROM merged
        WHERE ($3::bigint IS NULL OR (block_number, tx_hash, log_index) < ($3::bigint, $4::text, $5::integer))
        ORDER BY block_number DESC, tx_hash DESC, log_index DESC
        LIMIT $6`,
      [chainId, token, cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null,
        cursor?.logIndex ?? null, query.limit + 1]);
      const rows = result.rows as Row[];
      const visible = rows.slice(0, query.limit);

      // Pool rows only carry raw amount0/amount1 — resolve which side is this launch's own token
      // vs the pool's quote asset (and each side's decimals) once per distinct pool on this page,
      // not once per row (mirrors readPoolTrades' one-pool case, generalized to many pools).
      const poolKeys = [...new Map(visible.filter((row) => row.source === 'pool')
        .map((row) => [`${string(row.protocol)}:${string(row.pool_id)}`, { protocol: string(row.protocol), poolId: string(row.pool_id) }]))
        .values()];
      const poolCurrencies = new Map<string, { currency0: string; currency1: string }>();
      if (poolKeys.length > 0) {
        const catalogRows = (await pool.query(
          `SELECT protocol, pool_id, currency0, currency1 FROM pool_catalog
           WHERE chain_id = $1 AND (protocol, pool_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
          [chainId, poolKeys.map((k) => k.protocol), poolKeys.map((k) => k.poolId)],
        )).rows as Row[];
        for (const row of catalogRows) {
          poolCurrencies.set(`${string(row.protocol)}:${string(row.pool_id)}`, { currency0: string(row.currency0), currency1: string(row.currency1) });
        }
      }
      const distinctAddresses = [...new Set([...poolCurrencies.values()].flatMap((c) => [c.currency0, c.currency1]))];
      const decimalsByAddress = new Map<string, number | null>(
        await Promise.all(distinctAddresses.map(async (address) => [address, await assetDecimals(rpcClient, address)] as const)),
      );

      interface Interpreted { side: 'buy' | 'sell'; tokenAmountRaw: bigint; quoteAmountRaw: bigint;
        quoteAssetAddress: string | null; quoteAssetDecimals: number | null; tokenDecimals: number | null }
      function interpret(row: Row): Interpreted {
        if (row.source === 'official') {
          return { side: string(row.side) as 'buy' | 'sell', tokenAmountRaw: BigInt(string(row.amount_a_raw)),
            quoteAmountRaw: BigInt(string(row.amount_b_raw)), quoteAssetAddress: nullableString(row.quote_asset_address),
            quoteAssetDecimals: nullableNumber(row.quote_asset_decimals), tokenDecimals: nullableNumber(row.token_decimals) };
        }
        const key = `${string(row.protocol)}:${string(row.pool_id)}`;
        const currencies = poolCurrencies.get(key);
        const displayedIsCurrency0 = currencies?.currency0 === token;
        const signed = BigInt(string(displayedIsCurrency0 ? row.amount_a_raw : row.amount_b_raw));
        const quoteSigned = BigInt(string(displayedIsCurrency0 ? row.amount_b_raw : row.amount_a_raw));
        const quoteAssetAddress = currencies ? (displayedIsCurrency0 ? currencies.currency1 : currencies.currency0) : null;
        return { side: signed < 0n ? 'buy' : 'sell', tokenAmountRaw: signed < 0n ? -signed : signed,
          quoteAmountRaw: quoteSigned < 0n ? -quoteSigned : quoteSigned, quoteAssetAddress,
          quoteAssetDecimals: quoteAssetAddress ? decimalsByAddress.get(quoteAssetAddress) ?? null : null,
          tokenDecimals: currencies ? decimalsByAddress.get(token) ?? null : null };
      }
      const interpreted = visible.map(interpret);

      // Resolve one verified feed per DISTINCT quote asset on this page (not per row), then value
      // each row and coalesce pending-backfill ranges per feed — generalizes listTrades' single-feed
      // coalescing (that method only ever has one quote asset per page; this one can have many,
      // since different pools can quote in different assets).
      const distinctQuoteAssets = [...new Set(interpreted.map((i) => i.quoteAssetAddress).filter((a): a is string => a !== null))];
      const feedByQuoteAsset = new Map(await Promise.all(distinctQuoteAssets.map(async (address) =>
        [address, await resolveVerifiedFeed(pool, chainId, address)] as const)));
      const valuations = await Promise.all(visible.map((row, i) => {
        const info = interpreted[i]!;
        if (info.quoteAssetDecimals === null) return Promise.resolve({ status: 'unavailable' as const });
        return valueTradeUsd(pool, chainId, info.quoteAssetAddress!, { timestamp: number(row.timestamp),
          quoteAmountRaw: info.quoteAmountRaw, quoteAssetDecimals: info.quoteAssetDecimals,
          blockNumber: BigInt(string(row.block_number)), logIndex: number(row.log_index) });
      }));
      const pendingByFeed = new Map<string, number[]>();
      valuations.forEach((valuation, i) => {
        if (valuation.status !== 'pending') return;
        const feed = feedByQuoteAsset.get(interpreted[i]!.quoteAssetAddress ?? '');
        if (!feed) return;
        const list = pendingByFeed.get(feed.feedAddress) ?? [];
        list.push(number(visible[i]!.timestamp));
        pendingByFeed.set(feed.feedAddress, list);
      });
      await Promise.all([...pendingByFeed.entries()].map(([feedAddress, timestamps]) =>
        enqueueRoundBackfillJob(pool, chainId, feedAddress, Math.min(...timestamps) - 3600, Math.max(...timestamps) + 3600).catch(() => {})));

      return page(rows, query.limit, (row, i) => {
        const info = interpreted[i]!;
        return {
          source: row.source as 'official' | 'pool',
          venueId: nullableString(row.venue_id),
          pool: row.protocol ? { protocol: row.protocol as TransactionResponse['pool'] extends infer P ? P extends null ? never : P['protocol'] : never, poolId: string(row.pool_id) } : null,
          blockNumber: string(row.block_number), txHash: string(row.tx_hash), logIndex: number(row.log_index),
          timestamp: number(row.timestamp), side: info.side, activityKind: nullableString(row.activity_kind),
          tokenAmount: info.tokenDecimals === null ? null : formatUnits(info.tokenAmountRaw, info.tokenDecimals),
          quoteAmount: info.quoteAssetDecimals === null ? null : formatUnits(info.quoteAmountRaw, info.quoteAssetDecimals),
          quoteAssetAddress: info.quoteAssetAddress,
          traderAddress: string(row.trader_address),
          usdValue: valuations[i]!.status === 'priced' ? (valuations[i] as { status: 'priced'; usdValue: string }).usdValue : null,
          usdValueApprox: valuations[i]!.status === 'priced',
          usdValueStatus: valuations[i]!.status,
        };
      }) as Page<TransactionResponse>;
    },
```

The `pool: row.protocol ? {...} : never` conditional type above is awkward — simplify it immediately by declaring the field plainly instead:

```ts
          pool: row.protocol ? { protocol: string(row.protocol) as 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2', poolId: string(row.pool_id) } : null,
```

Use that simpler line, not the `infer`-based one (that line only existed to think through the type; replace it before running).

Finally, change the factory signature so `rpcClient` is in scope for the function above:

```ts
export function createApiStore(pool: Pool, rpcClient?: UsdPriceClient): ApiDeps['data'] {
```

(was `export function createApiStore(pool: Pool): ApiDeps['data']` — just add the second parameter; every other method in the returned object ignores it, exactly like `createPoolApiStore`'s existing optional `rpcClient` parameter.)

- [ ] **Step 5: Update the two call sites of `createApiStore`**

In `be/src/cli/api.ts`, line 15 already computes `rpcClient` one line above (used for `createPoolApiStore`) — change:

```ts
const app = await createApiServer({ feOrigin: config.feOrigin, data: createApiStore(pool),
  pools: createPoolApiStore(pool, rpcClient), events });
```

to:

```ts
const app = await createApiServer({ feOrigin: config.feOrigin, data: createApiStore(pool, rpcClient),
  pools: createPoolApiStore(pool, rpcClient), events });
```

`be/src/cli/benchmarkVolumeRanking.ts`'s `createApiStore(pool)` call needs no change (the parameter is optional).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w be -- store.integration.test.ts -t listTransactions`
Expected: PASS

- [ ] **Step 7: Add the double-counting-exclusion test**

Add to the same `describe('listTransactions', ...)` block:

```ts
  it('excludes a pool that is also the official venue from the pool branch — no double-counted swap', async () => {
    await seedOfficialOnly();
    const v4PoolId = `0x${'d'.repeat(64)}`;
    const quote = '0x0000000000000000000000000000000000000000';
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
      block_number,block_hash,tx_hash,log_index,verified,coverage_status)
      VALUES (4663,'uniswap_v4',$1,$2,$3,3000,60,$4,2,$5,$6,0,true,'caught_up') ON CONFLICT DO NOTHING`,
    [v4PoolId, txToken < quote ? txToken : quote, txToken < quote ? quote : txToken, quote, blockHash, officialTxHash]);
    await pool.query(`INSERT INTO pool_members (chain_id,protocol,pool_id,token_address) VALUES (4663,'uniswap_v4',$1,$2) ON CONFLICT DO NOTHING`,
      [v4PoolId, txToken]);
    // The venue row IS this same pool_id as its `ref`, marked official — this is exactly the
    // Pons-graduated-V4-pool case the exclusion must catch.
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,effective_from_block,official)
      VALUES ($1,4663,$2,'v4_pool',$3,$4,2,true) ON CONFLICT (id) DO NOTHING`,
      [`pons-v2-v4:${txToken}`, txToken, v4PoolId, txSource]);
    await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,timestamp,
      amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
      VALUES (4663,$1,1,'uniswap_v4',$2,2,$3,1700000100,'-1000000000000000000','2000000000000000000','79228162514264337593543950336',$4,$4,3000)
      ON CONFLICT DO NOTHING`,
    [officialTxHash, v4PoolId, blockHash, txToken]);

    const page = await store.listTransactions(4663, txToken, { limit: 10 });
    expect(page.items.filter((item) => item.source === 'pool')).toHaveLength(0);

    await pool.query('DELETE FROM pool_trades WHERE pool_id = $1', [v4PoolId]);
    await pool.query('DELETE FROM venues WHERE id = $1', [`pons-v2-v4:${txToken}`]);
    await pool.query('DELETE FROM pool_members WHERE pool_id = $1', [v4PoolId]);
    await pool.query('DELETE FROM pool_catalog WHERE pool_id = $1', [v4PoolId]);
  });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -w be -- store.integration.test.ts -t "excludes a pool"`
Expected: PASS

- [ ] **Step 9: Add the merged-ordering and pagination test**

```ts
  it('interleaves official and pool rows by (block, tx, logIndex) and paginates the merged sequence without gaps or repeats', async () => {
    await seedOfficialOnly(); // block_number=1, tx=officialTxHash, log_index=0, side=buy
    const otherPoolId = `0x${'e'.repeat(64)}`;
    const quote = '0x0000000000000000000000000000000000000000';
    const poolTx = '0x' + 'f'.repeat(64);
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
      block_number,block_hash,tx_hash,log_index,verified,coverage_status)
      VALUES (4663,'uniswap_v4',$1,$2,$3,3000,60,$4,0,$5,$6,0,true,'caught_up') ON CONFLICT DO NOTHING`,
    [otherPoolId, txToken < quote ? txToken : quote, txToken < quote ? quote : txToken, quote, blockHash, poolTx]);
    await pool.query(`INSERT INTO pool_members (chain_id,protocol,pool_id,token_address) VALUES (4663,'uniswap_v4',$1,$2) ON CONFLICT DO NOTHING`,
      [otherPoolId, txToken]);
    // block_number=2, i.e. AFTER the official trade at block 1 — must sort first (DESC).
    await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,timestamp,
      amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
      VALUES (4663,$1,0,'uniswap_v4',$2,2,$3,1700000200,'-1000000000000000000','2000000000000000000','79228162514264337593543950336',$4,$4,3000)
      ON CONFLICT DO NOTHING`,
    [poolTx, otherPoolId, blockHash, txToken]);

    const first = await store.listTransactions(4663, txToken, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.source).toBe('pool'); // block 2, newest first
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listTransactions(4663, txToken, { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.source).toBe('official'); // block 1
    expect(second.nextCursor).toBeNull();

    await pool.query('DELETE FROM pool_trades WHERE pool_id = $1', [otherPoolId]);
    await pool.query('DELETE FROM pool_members WHERE pool_id = $1', [otherPoolId]);
    await pool.query('DELETE FROM pool_catalog WHERE pool_id = $1', [otherPoolId]);
  });
```

- [ ] **Step 10: Run the full `listTransactions` describe block and the full `be` test suite**

Run: `npm test -w be -- store.integration.test.ts -t listTransactions`
Expected: PASS (3 tests)

Run: `npm test -w be`
Expected: PASS (no regressions in `listTrades`/other store tests)

- [ ] **Step 11: Commit**

```bash
git add be/src/api/store.ts be/src/api/server.ts be/src/cli/api.ts be/src/api/store.integration.test.ts
git commit -m "feat(be): add listTransactions merging official trades and other pools' swaps"
```

---

## Task 2: Backend — route, schema, and route-level test

**Files:**
- Modify: `be/src/api/schemas.ts` (add `transaction` schema)
- Modify: `be/src/api/routes/launches.ts` (add the route)
- Test: `be/src/api/server.test.ts` (new route test, mocked `data`)

**Interfaces:**
- Consumes: `TransactionResponse` and `data.listTransactions` from Task 1; `pageSchema`, `tokenParams`-equivalent validation and `listQuery` helpers already in `routes/launches.ts`.
- Produces: `GET /v1/launches/:chainId/:tokenAddress/transactions` — same query/response contract shape as `/trades` plus `source`/`venueId`/`pool`, consumed by Task 3's OpenAPI regen and Task 3's new `getLaunchTransactions` FE client function.

- [ ] **Step 1: Write the failing route test**

Add to `be/src/api/server.test.ts`, near the existing `'serves token trades and candles...'` test (reuse its `data()` factory and `address` constant):

```ts
  it('serves merged transactions without fabricating pagination when there are none', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: { ...data(),
      listTransactions: async (_chainId, _tokenAddress, query) => { expect(query.limit).toBe(2); return { items: [], nextCursor: null }; } } });
    const response = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/transactions?limit=2` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    await app.close();
  });

  it('rejects an invalid transactions query the same way /trades does', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data() });
    const response = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/transactions?limit=0` });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
```

Also extend the existing `data()` factory function in this test file (find it near the top, it already returns an object with `listTrades`, `listCandles`, etc.) to add a default `listTransactions: async () => ({ items: [], nextCursor: null })` entry, so every other existing test in this file keeps compiling against the full `ApiDeps['data']` interface.

Also extend the existing `'serves an OpenAPI document covering every implemented endpoint'`-style test (search this file for `toContain('/v1/launches/{chainId}/{tokenAddress}/trades')`) to add:

```ts
    expect(Object.keys(response.json().paths)).toContain('/v1/launches/{chainId}/{tokenAddress}/transactions');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w be -- server.test.ts -t "merged transactions"`
Expected: FAIL (404, route doesn't exist yet) and a TypeScript error from the missing `listTransactions` on the mock `data()` object if you typecheck first — add the `listTransactions` stub to `data()` before running, so the only failure is the 404/missing-path assertions.

- [ ] **Step 3: Add the `transaction` schema**

In `be/src/api/schemas.ts`, after the existing `trade` export, add:

```ts
export const transaction = { type: 'object', properties: {
  source: { type: 'string', enum: ['official', 'pool'] },
  venueId: { type: 'string', nullable: true },
  pool: { type: 'object', nullable: true, properties: { protocol: { type: 'string' }, poolId: { type: 'string' } } },
  blockNumber: { type: 'string' }, txHash: { type: 'string' }, logIndex: { type: 'integer' }, timestamp: { type: 'integer' },
  side: { type: 'string' }, activityKind: { type: 'string', nullable: true },
  tokenAmount: { type: 'string', nullable: true }, quoteAmount: { type: 'string', nullable: true },
  quoteAssetAddress: { type: 'string', nullable: true }, traderAddress: { type: 'string' },
  usdValue: { type: 'string', nullable: true }, usdValueApprox: { type: 'boolean' },
  usdValueStatus: { type: 'string', enum: ['priced', 'pending', 'unavailable'] },
} } as const;
```

- [ ] **Step 4: Add the route**

In `be/src/api/routes/launches.ts`, update the import line to add `transaction`:

```ts
import { candle, launchDetail, launchSummary, pageSchema, trade, transaction } from '../schemas.js';
```

Add this route directly after the existing `/trades` route (reuse the same `tokenParams`/`listQuery` validation already used there):

```ts
  app.get<{ Params: { chainId: string; tokenAddress: string }; Querystring: Record<string, string | undefined> }>(
    '/v1/launches/:chainId/:tokenAddress/transactions', { schema: { response: { 200: pageSchema(transaction) } } }, async (request, reply) => {
      const identity = tokenParams(request.params);
      const query = listQuery(request.query);
      if (!identity) return reply.code(404).send({ error: 'Launch not found' });
      if (!query) return reply.code(400).send({ error: 'Invalid transaction query' });
      return deps.data.listTransactions(identity.chainId, identity.tokenAddress, query);
    },
  );
```

(`tokenParams` is the existing helper already used by the `/trades` and `/candles` routes in this same file — reuse it as-is, no new helper needed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w be -- server.test.ts`
Expected: PASS (all tests, including the two new ones and the OpenAPI path list)

- [ ] **Step 6: Commit**

```bash
git add be/src/api/schemas.ts be/src/api/routes/launches.ts be/src/api/server.test.ts
git commit -m "feat(be): expose GET /v1/launches/:chainId/:tokenAddress/transactions"
```

---

## Task 3: Regenerate OpenAPI + FE generated types + FE client function

**Files:**
- Modify: `be/openapi.json` (generated)
- Modify: `fe/src/api/schema.ts` (generated)
- Modify: `fe/src/api/client.ts` (add `Transaction`, `TransactionPage`, `getLaunchTransactions`)

**Interfaces:**
- Consumes: the route from Task 2.
- Produces: `export type Transaction = Required<NonNullable<TransactionsBody['items']>[number]>;`, `export interface TransactionPage { items: readonly Transaction[]; nextCursor: string | null }`, `export async function getLaunchTransactions(chainId: number, tokenAddress: string, query: TradeQuery = {}): Promise<TransactionPage>` — consumed by Task 6 (`transaction-list.tsx`) and Task 7 (`page.tsx`).

- [ ] **Step 1: Regenerate the OpenAPI document**

Run: `npm run openapi:write -w be`
Expected: `be/openapi.json` changes to include the new `/transactions` path and `transaction` schema (verify with `git diff --stat be/openapi.json` showing a non-empty diff).

- [ ] **Step 2: Regenerate the FE schema types**

Run: `npm run generate:schema -w fe`
Expected: `fe/src/api/schema.ts` changes to include a `"/v1/launches/{chainId}/{tokenAddress}/transactions"` path entry (verify with `git diff --stat fe/src/api/schema.ts` showing a non-empty diff).

- [ ] **Step 3: Add the FE client type and function**

In `fe/src/api/client.ts`, after the existing `Trade`/`TradePage` exports (around line 98-103), add:

```ts
type TransactionsBody = paths['/v1/launches/{chainId}/{tokenAddress}/transactions']['get']['responses'][200]['content']['application/json'];

export type Transaction = Required<NonNullable<TransactionsBody['items']>[number]>;

export interface TransactionPage {
  items: readonly Transaction[];
  nextCursor: string | null;
}
```

After the existing `getLaunchTrades` function (around line 133-135), add:

```ts
export async function getLaunchTransactions(chainId: number, tokenAddress: string, query: TradeQuery = {}): Promise<TransactionPage> {
  return request<TransactionPage>(`/v1/launches/${chainId}/${tokenAddress}/transactions`, { cursor: query.cursor, limit: query.limit });
}
```

(Reuses the existing `TradeQuery` interface — same shape, no need for a new query type.)

- [ ] **Step 4: Typecheck**

Run: `npm run build -w fe` (or `npx tsc --noEmit -p fe` if a faster typecheck-only script exists — check `fe/package.json`'s `scripts` for a `typecheck` entry first and prefer that)
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add be/openapi.json fe/src/api/schema.ts fe/src/api/client.ts
git commit -m "chore: regenerate OpenAPI/FE types for the transactions endpoint, add client fn"
```

---

## Task 4: Frontend — rounding rule fixes in `format.ts`

**Files:**
- Modify: `fe/src/api/format.ts`
- Modify: `fe/src/api/format.test.ts`
- Modify: `fe/src/features/launch/launch-detail.test.tsx` (one existing assertion string changes)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function formatAmount(value: string | null, decimals?: number): string` (new); `formatPrice`'s *output* changes for sub-1 values (3 significant figures instead of today's 2), used by Task 6's `transaction-list.tsx` and already used by `launch-detail.tsx`/`pool-detail.tsx`.

- [ ] **Step 1: Write the failing tests**

In `fe/src/api/format.test.ts`, add `formatAmount` to the existing import list from `./format`, and add this new `describe` block after the existing `formatPrice` block:

```ts
describe('formatAmount', () => {
  it('shows "—" instead of a fabricated value when null', () => {
    expect(formatAmount(null)).toBe('—');
  });

  it('shows exactly 0, not <0.01, for a true zero', () => {
    expect(formatAmount('0')).toBe('0');
  });

  it('shows "<0.01" instead of rounding a sub-cent amount down to 0.00', () => {
    expect(formatAmount('0.004')).toBe('<0.01');
  });

  it('rounds an ordinary amount to 2 decimal places by default', () => {
    expect(formatAmount('12.9649')).toBe('12.96');
  });

  it('accepts a custom decimals count', () => {
    expect(formatAmount('12.9649', 1)).toBe('13.0');
  });
});
```

Then fix the one existing `formatPrice` test that the sub-1 rounding change will invalidate — change:

```ts
  it('keeps enough decimal digits that a sub-1 Pons-scale price is not rounded away to 0.00', () => {
    expect(formatPrice('0.000000152480063034', 'ETH')).toBe('0.00000015 ETH');
  });
```

to:

```ts
  it('keeps enough decimal digits that a sub-1 Pons-scale price is not rounded away to 0.00', () => {
    expect(formatPrice('0.000000152480063034', 'ETH')).toBe('0.000000152 ETH');
  });

  it('rounds to exactly 3 significant (non-zero-leading) digits below 1 unit', () => {
    expect(formatPrice('0.00312344', 'ETH')).toBe('0.00312 ETH');
    expect(formatPrice('0.0003426', 'ETH')).toBe('0.000343 ETH');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w fe -- format.test.ts`
Expected: FAIL (`formatAmount` not exported; the two updated `formatPrice` expectations fail against the current 2-sig-fig output)

- [ ] **Step 3: Implement `formatAmount` and fix `formatPrice`**

In `fe/src/api/format.ts`, add after `formatQuote`:

```ts
// Transaction-row amounts (token/quote/USD columns): 2 decimals, but never silently round a real
// non-zero amount down to "0.00" — show the honest "<0.01" instead. Distinct from formatUsd's
// dynamic-decimals behavior (FDV/TVL/market cap), which expands precision instead of truncating
// the display — do not reuse this for those call sites.
export function formatAmount(value: string | null, decimals = 2): string {
  if (value === null) return '—';
  const numeric = Number(value);
  if (numeric === 0) return (0).toFixed(0);
  if (Math.abs(numeric) < 0.01) return '<0.01';
  return numeric.toFixed(decimals);
}
```

Replace the existing `formatPrice` function body:

```ts
export function formatPrice(value: string | null, symbol: string | null): string {
  if (value === null) return '—';
  const numeric = Number(value);
  // Below 1 unit, show exactly 3 significant (non-zero-leading) digits instead of a fixed decimal
  // count — a fixed 2-decimal count would round every Pons-scale price (far below $1) to 0.00.
  // At or above 1 unit, 2 decimals is always enough and this intentionally does NOT scale up to 3.
  const decimals = Number.isFinite(numeric) && numeric > 0 && numeric < 1
    ? -Math.floor(Math.log10(numeric)) + 2
    : 2;
  return `${numeric.toFixed(decimals)} ${symbol ?? '—'}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w fe -- format.test.ts`
Expected: PASS

- [ ] **Step 5: Fix the one downstream assertion in `launch-detail.test.tsx`**

Find the test `'shows the current official price'` (search for `0.00000015 ROBIN`) and change:

```ts
    expect(screen.getByText(/0\.00000015 ROBIN/)).toBeInTheDocument();
```

to:

```ts
    expect(screen.getByText(/0\.000000152 ROBIN/)).toBeInTheDocument();
```

- [ ] **Step 6: Run the full FE test suite**

Run: `npm test -w fe`
Expected: PASS (no other call site depends on the old sub-1 `formatPrice` rounding — confirmed by `grep -rn "0\.00000015" fe/src` during planning, which found only the two fixed locations)

- [ ] **Step 7: Commit**

```bash
git add fe/src/api/format.ts fe/src/api/format.test.ts fe/src/features/launch/launch-detail.test.tsx
git commit -m "fix(fe): add formatAmount(), round formatPrice to 3 significant digits below 1 unit"
```

---

## Task 5: Frontend — hand-rolled `Tabs` UI primitive

**Files:**
- Create: `fe/src/components/ui/tabs.tsx`
- Test: `fe/src/components/ui/tabs.test.tsx`

**Interfaces:**
- Consumes: `cn` from `fe/src/lib/utils.ts` (existing).
- Produces: `export function Tabs({ tabs, defaultValue }: { tabs: readonly { value: string; label: string; content: ReactNode }[]; defaultValue?: string })` — consumed by Task 7's `launch-detail.tsx`.

No new npm dependency: this repo's `fe/src/components/ui/*` are plain CVA-styled wrappers around native elements (confirmed: `button.tsx`/`badge.tsx` have no Radix import, and `fe/package.json` has no `@radix-ui/*` dependency) — a 2-tab switcher doesn't need Radix's full tab-list keyboard-navigation machinery; a plain `button`/`role="tablist"` pair is enough and keeps the pattern consistent.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs } from './tabs';

describe('Tabs', () => {
  it('shows the first tab\'s content by default and switches content on click, without unmounting the tablist', () => {
    render(<Tabs tabs={[
      { value: 'transactions', label: 'Transactions', content: <p>Transaction rows</p> },
      { value: 'pools', label: 'Pools', content: <p>Pool rows</p> },
    ]} />);
    expect(screen.getByText('Transaction rows')).toBeInTheDocument();
    expect(screen.queryByText('Pool rows')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(screen.getByText('Pool rows')).toBeInTheDocument();
    expect(screen.queryByText('Transaction rows')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pools' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute('aria-selected', 'false');
  });

  it('honors an explicit defaultValue', () => {
    render(<Tabs defaultValue="pools" tabs={[
      { value: 'transactions', label: 'Transactions', content: <p>Transaction rows</p> },
      { value: 'pools', label: 'Pools', content: <p>Pool rows</p> },
    ]} />);
    expect(screen.getByText('Pool rows')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fe -- tabs.test.tsx`
Expected: FAIL (`./tabs` module not found)

- [ ] **Step 3: Implement the component**

```tsx
'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ tabs, defaultValue }: { tabs: readonly TabItem[]; defaultValue?: string }) {
  const [active, setActive] = useState(defaultValue ?? tabs[0]?.value);
  const activeTab = tabs.find((tab) => tab.value === active) ?? tabs[0];
  return (
    <div>
      <div role="tablist" className="flex gap-4 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={tab.value === active}
            className={cn(
              'border-b-2 px-1 pb-2 text-sm font-medium',
              tab.value === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActive(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="pt-4">{activeTab?.content}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fe -- tabs.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fe/src/components/ui/tabs.tsx fe/src/components/ui/tabs.test.tsx
git commit -m "feat(fe): add a plain Tabs UI primitive"
```

---

## Task 6: Frontend — `transaction-list.tsx` table component

**Files:**
- Create: `fe/src/features/launch/transaction-list.tsx`
- Create: `fe/src/features/launch/transaction-list.test.tsx`

**Interfaces:**
- Consumes: `Transaction`, `OfficialVenue` from `@/api/client`; `displaySymbol`, `formatActivityKind`, `formatAmount`, `formatSide`, `formatVenueKind` from `@/api/format`; `Table`/`TableBody`/`TableCell`/`TableHead`/`TableHeader`/`TableRow` from `@/components/ui/table`; `TokenLogo` from `@/features/launches/token-logo`; `cn` from `@/lib/utils`.
- Produces: `export interface TransactionListProps { transactions: readonly Transaction[]; venues: readonly OfficialVenue[]; tokenSymbol: string | null; quoteAsset: { address: string; symbol: string | null }; explorerBase?: string }` and `export function TransactionList(props: TransactionListProps)` — consumed by Task 7's `launch-detail.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OfficialVenue, Transaction } from '@/api/client';
import { TransactionList } from './transaction-list';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    source: 'official', venueId: 'pons-v2-curve:0xtoken', pool: null,
    blockNumber: '100', txHash: '0xtx1', logIndex: 0, timestamp: 1_700_000_000,
    side: 'buy', activityKind: 'user_trade', tokenAmount: '10', quoteAmount: '1',
    quoteAssetAddress: '0xquote', traderAddress: '0x1234567890123456789012345678901234567890',
    usdValue: null, usdValueApprox: false, usdValueStatus: 'unavailable',
    ...overrides,
  };
}

const noVenues: readonly OfficialVenue[] = [];
const quoteAsset = { address: '0xquote', symbol: 'ROBIN' };

describe('TransactionList', () => {
  it('shows a loading state for a pending USD value, keeping the onchain amount visible', () => {
    render(<TransactionList transactions={[transaction({ usdValueStatus: 'pending' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText(/calculating|loading/i)).toBeInTheDocument();
  });

  it('labels a protocol buyback trade as done by Pons', () => {
    render(<TransactionList transactions={[transaction({ activityKind: 'protocol_buyback' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('Buyback by Pons')).toBeInTheDocument();
  });

  it('rounds the token/quote/USD amount columns to 2 decimals, showing <0.01 for a sub-cent amount', () => {
    render(<TransactionList transactions={[transaction({ tokenAmount: '523.1349', quoteAmount: '0.004',
      usdValue: '0.009', usdValueStatus: 'priced', usdValueApprox: true })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('523.13')).toBeInTheDocument();
    expect(screen.getAllByText('<0.01').length).toBeGreaterThanOrEqual(1);
  });

  it('labels a pool-sourced row distinctly from an official trade, without implying an official partnership', () => {
    render(<TransactionList transactions={[transaction({ source: 'pool', venueId: null,
      pool: { protocol: 'uniswap_v4', poolId: '0xpool' } })]} venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText(/pool/i)).toBeInTheDocument();
  });

  it('shows a truncated wallet address linking to the explorer address page', () => {
    render(<TransactionList transactions={[transaction({ traderAddress: '0x1234567890123456789012345678901234567890' })]}
      venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} explorerBase="https://explorer.example" />);
    const link = screen.getByRole('link', { name: /0x1234[…\.]{1,3}7890/i });
    expect(link).toHaveAttribute('href', 'https://explorer.example/address/0x1234567890123456789012345678901234567890');
  });

  it('still links to the transaction on the explorer', () => {
    render(<TransactionList transactions={[transaction({ txHash: '0xabc' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} explorerBase="https://explorer.example" />);
    const link = screen.getByRole('link', { name: 'Tx' });
    expect(link).toHaveAttribute('href', 'https://explorer.example/tx/0xabc');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w fe -- transaction-list.test.tsx`
Expected: FAIL (`./transaction-list` module not found)

- [ ] **Step 3: Implement the component**

```tsx
import { displaySymbol, formatActivityKind, formatAmount, formatSide } from '@/api/format';
import type { OfficialVenue, Transaction } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { cn } from '@/lib/utils';

export interface TransactionListProps {
  transactions: readonly Transaction[];
  venues: readonly OfficialVenue[];
  tokenSymbol: string | null;
  quoteAsset: { address: string; symbol: string | null };
  explorerBase?: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Pool quote assets vary per pool and this endpoint doesn't resolve arbitrary ERC20 symbols — same
// convention fe/src/features/pools/pool-list.tsx already uses: ETH for the zero address, otherwise
// a truncated address. The official venue's own quote asset DOES have a real resolved symbol
// (quoteAsset.symbol, from core-metadata enrichment), so that row type stays more precise.
function quoteLabel(row: Transaction, launchQuoteAsset: { address: string; symbol: string | null }): string {
  if (row.quoteAssetAddress === launchQuoteAsset.address) return displaySymbol(launchQuoteAsset.symbol);
  if (row.quoteAssetAddress === ZERO_ADDRESS) return 'ETH';
  return row.quoteAssetAddress ? shortAddress(row.quoteAssetAddress) : '—';
}

export function TransactionList({ transactions, tokenSymbol, quoteAsset, explorerBase }: TransactionListProps) {
  return (
    <Table aria-label="Transactions">
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">{displaySymbol(tokenSymbol)}</TableHead>
          <TableHead className="text-right">For</TableHead>
          <TableHead className="text-right">USD</TableHead>
          <TableHead>Wallet</TableHead>
          <TableHead>Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((row) => {
          const activityLabel = row.source === 'official' ? formatActivityKind(row.activityKind ?? '') : null;
          return (
            <TableRow key={`${row.blockNumber}-${row.txHash}-${row.logIndex}`}>
              <TableCell className="text-muted-foreground">{new Date(row.timestamp * 1000).toLocaleString('en-US')}</TableCell>
              <TableCell>
                <span className={cn('font-medium', !activityLabel && row.side === 'buy' && 'text-success', !activityLabel && row.side === 'sell' && 'text-destructive')}>
                  {activityLabel ?? formatSide(row.side)}
                </span>
                {row.source === 'pool' && <span className="ml-1 text-xs text-muted-foreground">(pool)</span>}
              </TableCell>
              <TableCell className="text-right font-mono">{formatAmount(row.tokenAmount)}</TableCell>
              <TableCell className="text-right font-mono">
                <span className="inline-flex items-center justify-end gap-1">
                  {formatAmount(row.quoteAmount)} {quoteLabel(row, quoteAsset)}
                  <TokenLogo logoUri={null} symbol={quoteLabel(row, quoteAsset)} />
                </span>
              </TableCell>
              <TableCell
                className="text-right font-mono"
                title={row.usdValueStatus === 'priced' ? 'Converted at the historical quote price near this trade\'s own execution time, not the current price' : undefined}
              >
                {row.usdValueStatus === 'pending' ? 'Calculating…' : formatAmount(row.usdValue)}
              </TableCell>
              <TableCell>
                {explorerBase ? (
                  <a href={`${explorerBase}/address/${row.traderAddress}`} target="_blank" rel="noreferrer noopener">
                    {shortAddress(row.traderAddress)}
                  </a>
                ) : shortAddress(row.traderAddress)}
              </TableCell>
              <TableCell>
                {explorerBase ? (
                  <a href={`${explorerBase}/tx/${row.txHash}`} target="_blank" rel="noreferrer noopener">
                    Tx
                  </a>
                ) : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w fe -- transaction-list.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fe/src/features/launch/transaction-list.tsx fe/src/features/launch/transaction-list.test.tsx
git commit -m "feat(fe): add TransactionList table matching the reference screenshot layout"
```

---

## Task 7: Frontend — wire the tab switcher into the launch detail page

**Files:**
- Modify: `fe/src/features/launch/launch-detail.tsx`
- Modify: `fe/src/app/launches/[chainId]/[tokenAddress]/page.tsx`
- Modify: `fe/src/features/launch/launch-detail.test.tsx`

**Interfaces:**
- Consumes: `TransactionList` (Task 6), `Tabs` (Task 5), `getLaunchTransactions`/`TransactionPage` (Task 3), existing `PoolList`.
- Produces: `LaunchDetailProps` changes from `trades: TradePage | null` to `transactions: TransactionPage | null` — this is a breaking prop rename; every caller/test must update together in this one task (no intermediate state where both exist, to avoid dead code).

- [ ] **Step 1: Update `page.tsx` to fetch transactions instead of trades**

In `fe/src/app/launches/[chainId]/[tokenAddress]/page.tsx`, change the import:

```ts
import { getLaunchCandles, getLaunchDetail, getLaunchPools, getLaunchTransactions } from '@/api/client';
```

Change the `Promise.all` call:

```ts
  const [transactions, candles, pools] = await Promise.all([
    getLaunchTransactions(chainId, tokenAddress).catch(() => null),
    getLaunchCandles(chainId, tokenAddress, { currency: chartCurrency, intervalSeconds: chartInterval }).catch(() => null),
    getLaunchPools(chainId, tokenAddress, { excludeOfficial: true }).catch(() => null),
  ]);
  const hasPendingTrade = transactions?.items.some((trade) => trade.usdValueStatus === 'pending') ?? false;
```

Change the `<LaunchDetail>` call: `trades={trades}` becomes `transactions={transactions}`.

- [ ] **Step 2: Update `launch-detail.tsx`'s props and graduation-marker derivation**

Change `LaunchDetailProps`: replace `trades: TradePage | null;` with `transactions: TransactionPage | null;`, and update the `import type { CandlePage, LaunchDetail as LaunchDetailData, PoolPage, TradePage }` line to import `TransactionPage` instead of `TradePage`.

Update the destructured prop in the function signature: `trades` → `transactions`.

Update the graduation-marker derivation (currently):

```ts
  const v4TradeTimestamps = v4Venue ? trades?.items.filter((trade) => trade.venueId === v4Venue.id).map((trade) => trade.timestamp) : undefined;
```

to:

```ts
  const v4TradeTimestamps = v4Venue
    ? transactions?.items.filter((row) => row.source === 'official' && row.venueId === v4Venue.id).map((row) => row.timestamp)
    : undefined;
```

Update `const hasPendingTrade = trades?.items.some(...)` references if any remain outside this file (there are none — that logic lives in `page.tsx`, already updated in Step 1).

- [ ] **Step 3: Replace the two stacked sections with the Tabs component**

Remove the existing "Official trading venues" `<section>` block's trade list usage and the "Other pools" `<section>` block (the two blocks currently between the About section and the chart, and the `{trades ? <Card>...<TradeList .../></Card> : <p role="status">...</p>}` block near the end). Keep the "Official trading venues" chip list exactly as-is (it stays above the tabs, unchanged) — only the `TradeList`/`PoolList`-rendering blocks move into the new `Tabs`.

Add this import:

```ts
import { Tabs } from '@/components/ui/tabs';
import { TransactionList } from './transaction-list';
```

Remove the now-unused `import { TradeList } from './trade-list';` line.

Replace the block that currently reads:

```tsx
      {pools && <section aria-label="Other pools"><h2 className="mb-3 text-lg font-semibold">Other pools</h2>
        <PoolList page={pools} tokenAddress={detail.tokenAddress} /></section>}
```

...through the end of the file's trailing `{trades ? (<Card>...</Card>) : (<p role="status">Could not load trades.</p>)}` block, with:

```tsx
      <Card>
        <CardContent className="pt-4">
          <Tabs
            tabs={[
              {
                value: 'transactions',
                label: 'Transactions',
                content: transactions ? (
                  <TransactionList
                    transactions={transactions.items}
                    venues={detail.officialVenues}
                    tokenSymbol={detail.symbol}
                    quoteAsset={detail.quoteAsset}
                    explorerBase={explorerBase}
                  />
                ) : (
                  <p role="status">Could not load transactions.</p>
                ),
              },
              {
                value: 'pools',
                label: 'Pools',
                content: pools ? (
                  <PoolList page={pools} tokenAddress={detail.tokenAddress} />
                ) : (
                  <p role="status">Could not load pools.</p>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
```

Place this block where the chart currently is (i.e. decide final ordering to match the reference screenshot: chips → chart → tabs, same relative order as the current chips → pools → chart → trades, just merged). Keep the chart `<Card>` block exactly where it already is, unmoved — only the trade/pool blocks merge into the one `Tabs` card above.

- [ ] **Step 4: Update `launch-detail.test.tsx` — rename the fixture helper and all usages**

Replace the `trade()` helper function (and its `Trade` type import) with:

```ts
import type { Candle, LaunchDetail as LaunchDetailData, OfficialVenue, Transaction } from '@/api/client';
// ...
function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    source: 'official', venueId: 'pons-v2-curve:0xtoken', pool: null,
    blockNumber: '100', txHash: '0xtx1', logIndex: 0, timestamp: 1_700_000_000,
    side: 'buy', activityKind: 'user_trade', tokenAmount: '10', quoteAmount: '1',
    quoteAssetAddress: '0xquote', traderAddress: '0xtrader',
    usdValue: null, usdValueApprox: false, usdValueStatus: 'unavailable',
    ...overrides,
  };
}
```

Delete these six now-redundant test cases (their exact row-rendering behavior is already covered directly on `TransactionList` by Task 6's tests — keeping them here too would test the same behavior at two layers): `'labels a protocol buyback trade as done by Pons, never as the user\'s own order'`, `'labels an unattributed internal Pons swap neutrally'`, `'shows an ordinary user trade as a buy/sell side, not a protocol label'`, `'shows the historical USD value for a priced trade, with a tooltip explaining it is historical not current'`, `'shows "—" for a trade USD value instead of a fabricated number when usdValue is null'`, `'keeps the exact decimal string for a 6-decimal token trade amount, without rounding it'`.

In every remaining test that passes a `trades={{ items: [...], nextCursor: null }}` prop, rename it to `transactions={{ items: [...], nextCursor: null }}` and change every `trade({...})` call inside those arrays to `transaction({...})`. This affects: the `'places the curve-to-V4 marker...'` test (also change its two `trade({ venueId: v4VenueId, ... })` calls — they already set `venueId`, which the new derivation still reads, so no further change needed there beyond the rename), and every other test in the file that currently passes `trades={{ items: [], nextCursor: null }}` or `trades={null}` (rename to `transactions={{ items: [], nextCursor: null }}` / `transactions={null}`).

Update the `'lists other pools...'` test, since "Other pools" is no longer a standalone heading — it's the Pools tab's content now:

```ts
  it('shows other pools under the Pools tab and shows empty-state content when pools are unavailable', () => {
    const otherPool = { chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'b'.repeat(64)}`,
      currency0: '0x1111111111111111111111111111111111111111', currency1: '0x2222222222222222222222222222222222222222',
      displayedToken: '0x1111111111111111111111111111111111111111', fee: 3000, tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000', createdBlock: '123', createdTimestamp: null,
      ponsDesignated: false, launchTokenAddress: null, volume24hUsd: null, priceInQuote: null,
      priceUsd: null, fdvUsd: null, tvlUsd: null, change1h: null, change1d: null,
      coverageStatus: 'backfilling', lastTradeTimestamp: null };
    const view = render(<LaunchDetail detail={detail()} transactions={null} candles={null}
      pools={{ items: [otherPool], nextCursor: null, supportedProtocols: ['uniswap_v4'] }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(view.container.querySelector(`a[href^="/pools/4663/uniswap_v4/0x${'b'.repeat(64)}"]`)).not.toBeNull();
    view.rerender(<LaunchDetail detail={detail()} transactions={null} candles={null} pools={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(screen.getByText('Could not load pools.')).toBeInTheDocument();
  });
```

(`fireEvent` is already imported at the top of this file.)

- [ ] **Step 5: Run the full FE test suite**

Run: `npm test -w fe`
Expected: PASS

- [ ] **Step 6: Run the dev server and manually verify in a browser**

Run: `npm run dev -w fe` (and `npm run dev -w be` in another terminal if not already running), then open a known launch detail page (e.g. the fixture token from `CLAUDE.md`'s "Verified facts" section, on whatever chain/token the local DB actually has data for) and confirm: the Transactions tab renders real rows with the new columns, clicking Pools shows the pool list, and no console errors appear.

- [ ] **Step 7: Commit**

```bash
git add fe/src/features/launch/launch-detail.tsx fe/src/app/launches/\[chainId\]/\[tokenAddress\]/page.tsx fe/src/features/launch/launch-detail.test.tsx
git commit -m "feat(fe): merge Transactions/Pools into one tab switcher on the launch detail page"
```

- [ ] **Step 8: Delete the now-unused `trade-list.tsx`, if nothing else references it**

Run: `grep -rln "from './trade-list'" fe/src; grep -rln "TradeList" fe/src`
Expected: only `fe/src/features/launch/trade-list.tsx` and `fe/src/features/launch/trade-list.test.tsx` themselves remain in the result (no other importer).

If confirmed unused, delete both files and commit:

```bash
git rm fe/src/features/launch/trade-list.tsx fe/src/features/launch/trade-list.test.tsx
git commit -m "chore(fe): remove trade-list.tsx, superseded by transaction-list.tsx"
```

If something else still imports it, skip this step and leave a one-line note in the final report instead of deleting.

---

## Task 8: Frontend — opt-in dark theme toggle

**Files:**
- Modify: `fe/src/app/globals.css`
- Modify: `fe/src/app/layout.tsx`
- Modify: `fe/src/components/app-shell.tsx`
- Modify: `fe/src/components/app-shell.test.tsx`
- Create: `fe/src/components/theme-toggle.tsx`
- Create: `fe/src/components/theme-toggle.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function ThemeToggle()` — a client component that toggles the `dark` class on `<html>` and persists the choice to `localStorage['theme']`.

- [ ] **Step 1: Add dark tokens to `globals.css`**

After the existing `@theme { ... }` block, add a `.dark` override block with the same variable names (pick reasonable dark equivalents — background near-black, foreground near-white, primary kept recognizably blue, etc.; exact hex values are a visual judgment call for whoever implements this step, following the same CSS custom-property names as the existing light block so no other file needs to change):

```css
.dark {
  --color-background: #0b0d12;
  --color-foreground: #e6e8ee;
  --color-card: #11141b;
  --color-card-foreground: #e6e8ee;
  --color-primary: #6b8bff;
  --color-primary-foreground: #0b0d12;
  --color-secondary: #1a1e28;
  --color-secondary-foreground: #e6e8ee;
  --color-muted: #161920;
  --color-muted-foreground: #9aa1b2;
  --color-accent: #1b2440;
  --color-accent-foreground: #6b8bff;
  --color-destructive: #f87171;
  --color-destructive-foreground: #0b0d12;
  --color-border: #262b36;
  --color-input: #262b36;
  --color-ring: #6b8bff;
  --color-success: #4ade80;
  --color-success-foreground: #0b0d12;
}
```

- [ ] **Step 2: Write the failing `ThemeToggle` test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
  });
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
  });

  it('defaults to light (no dark class, nothing in localStorage)', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggles the dark class on <html> and persists the choice', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w fe -- theme-toggle.test.tsx`
Expected: FAIL (`./theme-toggle` module not found)

- [ ] **Step 4: Implement `ThemeToggle`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !isDark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
    setIsDark(next);
  }

  return (
    <Button type="button" variant="ghost" size="sm" onClick={toggle} aria-label="Toggle dark theme">
      {isDark ? 'Light mode' : 'Dark mode'}
    </Button>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w fe -- theme-toggle.test.tsx`
Expected: PASS

- [ ] **Step 6: Add the no-FOUC inline script to `layout.tsx` and wire the toggle into `AppShell`**

In `fe/src/app/layout.tsx`, add a `<head>` with an inline script before `<body>`:

```tsx
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body><WalletProviders>{children}</WalletProviders></body>
    </html>
  );
}
```

In `fe/src/components/app-shell.tsx`, add the toggle next to `WalletControl`:

```tsx
import { ThemeToggle } from './theme-toggle';
// ...
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <WalletControl />
          </div>
```

(replacing the bare `<WalletControl />` with this wrapped pair, inside the existing header flex row).

- [ ] **Step 7: Update `app-shell.test.tsx` if it asserts the header's exact child structure**

Run: `npm test -w fe -- app-shell.test.tsx`
Expected: PASS unchanged, unless an existing test asserts an exact list of header children — if it does, add `'Dark mode'` (the toggle's initial label) to the expected set, following the pattern of whatever assertion already exists there for `WalletControl`.

- [ ] **Step 8: Run the full FE test suite and manually verify**

Run: `npm test -w fe`
Expected: PASS

Run: `npm run dev -w fe`, open any page, click the new toggle in the header, confirm the background/foreground/card colors actually switch and persist across a page reload (reload the tab manually and check the toggle's label still reflects the last choice with no light-then-dark flash).

- [ ] **Step 9: Commit**

```bash
git add fe/src/app/globals.css fe/src/app/layout.tsx fe/src/components/app-shell.tsx fe/src/components/app-shell.test.tsx fe/src/components/theme-toggle.tsx fe/src/components/theme-toggle.test.tsx
git commit -m "feat(fe): add an opt-in dark theme toggle, default stays light"
```

---

## Task 9: Docs — record the additive decisions and final verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add one line to CLAUDE.md's "Decisions already made" section**

Add, after the existing "Light UI with a blue accent is preferred..." bullet:

```markdown
- Added 2026-10-06: an opt-in dark theme toggle (header button, persisted to `localStorage`) sits alongside the light-UI default above — this is additive, not a reversal; light with blue accent remains what a first-time visitor sees. The launch detail page's official trades and other-pools sections were merged into one Transactions/Pools tab switcher (`fe/src/features/launch/transaction-list.tsx`), backed by a new merged backend endpoint (`GET /v1/launches/:chainId/:tokenAddress/transactions`, `be/src/api/store.ts`'s `listTransactions`) that unions official trades with other pools' swaps for the same token, excluding any pool that is itself an official venue so a swap is never counted twice.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm test -w be`
Expected: PASS

Run: `npm test -w fe`
Expected: PASS

Run: `npm run lint -w be && npm run lint -w fe` (check exact script names in each `package.json` first if these don't match)
Expected: PASS

Run: `npm run openapi:check -w be`
Expected: PASS (confirms `be/openapi.json` committed in Task 3 is still in sync with the route code)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the dark-theme-toggle and transactions-tab additions in CLAUDE.md"
```
