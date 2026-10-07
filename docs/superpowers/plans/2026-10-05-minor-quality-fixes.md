# Minor Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the owner's batch of small frontend/backend/Envio-sync quality fixes from the spec, each as its own reviewable commit on `main`.

**Architecture:** Eleven independent tasks touching `be/` (shared metadata type, Envio V2 read concurrency, a bigint migration, a formatting dedup, and a leaner list API) and `fe/` (About section: copy/URL validation/chain explorer/description-overflow, mobile launch-card labels, and an e2e assertion rewrite). No task depends on another's code, but tasks 6-9 all touch `about-section.tsx`/`launch-detail.tsx` and must run in the listed order so each commit's diff stays small.

**Tech Stack:** Node.js >=24, TypeScript, Fastify, viem, PostgreSQL, Drizzle (be); Next.js, React, TypeScript, Tailwind, shadcn/ui (fe); Vitest + PostgreSQL integration tests (be), Vitest + jsdom + Playwright (fe).

**Spec:** `docs/superpowers/specs/2026-10-04-minor-quality-fixes-design.md`

## Global Constraints

- Frontend copy stays English; code identifiers/tests/comments/API fields/filenames stay English (CLAUDE.md).
- Null means unavailable/incomplete — never silently convert missing data to zero or fabricate a value (CLAUDE.md, spec intent).
- Work directly on `main`, one commit per task, in this same session (CLAUDE.md: solo developer, no worktrees/subagents for this work).
- No live (Supabase/dev) DB migration, no deployment, no USD-ranking work, no legacy-RPC-indexer changes in this batch (spec "Verification and boundaries").
- Do not add a deprecated `execCommand` clipboard fallback (spec).
- Do not impose an x.com/twitter.com host requirement on `twitterUrl` (spec).
- `fe/AGENTS.md` warns this is a non-standard Next.js build with its own docs under `node_modules/next/dist/docs/` — none of this plan's FE tasks touch routing/data-fetching APIs, only client components, so no doc lookup is required before starting.

## Review Focus

- A `description` that is only whitespace (e.g. `"   \n  "`) must be treated the same as empty — no paragraph, no toggle (about-section).
- Rapid double-clicks on "Copy address" must not let a stale `setTimeout` from the first click clobber the state set by the second click (about-section).
- An IPFS logo URI with an empty CID (`ipfs://`) must fall back to the placeholder, not resolve to a bare gateway URL (token logo / url validation).
- A launch on a chain with no registered explorer must not silently inherit the Robinhood Blockscout link for any UI element (about-section explorer pill, already correct for the "View on Blockscout" link; the bug is in the About pill).
- `listLaunchesByVolume`'s base query must keep excluding `description` too — the spec's complaint applies to both list code paths (recency and volume-sort), not just the one it quotes literally.

---

## Task 1: Shared `ExtendedLaunchMetadata` type

**Files:**
- Modify: `be/src/launchpads/pons/extendedMetadata.ts`
- Modify: `be/src/launchpads/pons/v1/adapter.ts:64-65`
- Modify: `be/src/launchpads/pons/v2/adapter.ts:44-46`
- Modify: `be/src/envioSync/transformV2.ts:34-38`

**Interfaces:**
- Produces: `ExtendedLaunchMetadata` (exported from `extendedMetadata.ts`) = `{ logoUri: string | null; description: string | null; websiteUrl: string | null; twitterUrl: string | null; launchTimestamp: number | null }`.

- [ ] **Step 1: Add the shared interface**

In `be/src/launchpads/pons/extendedMetadata.ts`, add next to the existing `ExtendedTokenMetadata`:

```ts
export interface ExtendedLaunchMetadata extends ExtendedTokenMetadata {
  launchTimestamp: number | null;
}
```

- [ ] **Step 2: Use it at the three call sites**

In `be/src/launchpads/pons/v1/adapter.ts`, add `import type { ExtendedLaunchMetadata } from '../extendedMetadata.js';` and change line 65's inline type to:

```ts
export function hydrateV1Launch(event: V1LaunchEvent, factory: FactorySource, metadata: V1TokenMetadata, graduated: boolean,
  extended?: ExtendedLaunchMetadata): LaunchWithVenue {
```

In `be/src/launchpads/pons/v2/adapter.ts`, add the same import and change line 46's inline type to `extended?: ExtendedLaunchMetadata): V2LaunchWithVenue {`.

In `be/src/envioSync/transformV2.ts`, add `import type { ExtendedLaunchMetadata } from '../launchpads/pons/extendedMetadata.js';` and change line 38's inline type to `extended?: ExtendedLaunchMetadata,`.

- [ ] **Step 3: Typecheck**

Run: `cd be && npm run typecheck`
Expected: no errors (this is a type-only change; `mapMetadataReadResults`'s return shape already structurally matches `ExtendedLaunchMetadata`, and the three call sites already pass that exact shape).

- [ ] **Step 4: Commit**

```bash
git add be/src/launchpads/pons/extendedMetadata.ts be/src/launchpads/pons/v1/adapter.ts be/src/launchpads/pons/v2/adapter.ts be/src/envioSync/transformV2.ts
git commit -m "refactor: extract shared ExtendedLaunchMetadata type for Pons adapters/Envio transforms"
```

---

## Task 2: Parallelize independent reads in Envio V2 sync

**Files:**
- Modify: `be/src/envioSync/runSyncV2.ts:170-187`
- Test: `be/src/envioSync/runSyncV2.integration.test.ts`

**Interfaces:**
- Consumes: `readV2TokenMetadata(client, address)`, `resolveV2QuoteAsset(pairToken, client)`, `resolveKnownQuoteAsset(pairToken)`, `readExtendedTokenMetadataOutcomes(client, address)`, `readLaunchTimestamp(client, blockNumber)`, `mapMetadataReadResults(...)` — all unchanged signatures.

- [ ] **Step 1: Write the failing concurrency test**

Add to `be/src/envioSync/runSyncV2.integration.test.ts` (inside the `describe('syncV2ToReal', ...)` block, after the existing "indexes V2 through a transient optional read failure" test):

```ts
  it('starts metadata, quote-asset, and extended-metadata reads concurrently, not sequentially', async () => {
    const token = '0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9c';
    const curve = '0x9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9e';
    const pair = '0x9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9f';
    const launchTx = '0x' + '9f'.repeat(32);
    const blockHash = '0x' + 'a0'.repeat(32);
    const started: string[] = [];
    let releaseMetadata!: () => void;
    let releaseQuote!: () => void;
    let releaseExtended!: () => void;
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const quoteGate = new Promise<void>((resolve) => { releaseQuote = resolve; });
    const extendedGate = new Promise<void>((resolve) => { releaseExtended = resolve; });
    const client = {
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        const addr = address.toLowerCase();
        if (addr === token && functionName === 'name') { started.push('name'); await metadataGate; return 'Concurrent V2'; }
        if (addr === token && functionName === 'symbol') return 'CONC2';
        if (addr === token && functionName === 'decimals') return 18;
        if (addr === token && functionName === 'logo') { started.push('logo'); await extendedGate; return null; }
        if (addr === token && functionName === 'description') return null;
        if (addr === token && functionName === 'socials') return ['', '', '', '', ''];
        if (addr === pair && functionName === 'symbol') { started.push('quoteSymbol'); await quoteGate; return 'NOVELQ'; }
        if (addr === pair && functionName === 'decimals') return 18;
        throw new Error(`unexpected ${address} ${functionName}`);
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    };
    try {
      for (const id of ['pons-v2', 'pons-v2-curve', 'pons-v2-lifecycle']) {
        await db.insert(sources).values({ id, chainId: 4663, version: 'v2', factoryAddress: token,
          startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' }).onConflictDoNothing();
      }
      await envioPool.query(`INSERT INTO envio_fixture_v2."RawLaunchV2" VALUES ('concurrent',4663,$1,$2,$1,$3,27823666,$4,$5,30)`,
        [token, curve, pair, blockHash, launchTx]);
      const syncPromise = syncV2ToReal(envioPool, db, fixtureTables, client);
      // Let the microtask queue drain so every independent read has had a chance to start before
      // any of them is allowed to resolve — a sequential-await implementation would only have
      // called 'name' by this point, not 'logo' or 'quoteSymbol'.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started.sort()).toEqual(['logo', 'name', 'quoteSymbol']);
      releaseMetadata(); releaseQuote(); releaseExtended();
      await syncPromise;
    } finally {
      await db.delete(lifecycleTransitions).where(eq(lifecycleTransitions.tokenAddress, token));
      await db.delete(trades).where(eq(trades.tokenAddress, token));
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('TRUNCATE envio_fixture_v2."RawLaunchV2", envio_fixture_v2."RawCurveTrade", envio_fixture_v2."RawCurveBuyback", envio_fixture_v2."RawLifecycleTransition"');
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && npm run test:integration -- runSyncV2`
Expected: FAIL — `started` only contains `['name']` at the checkpoint (today's code awaits metadata fully before starting the quote-asset or extended-metadata reads), so the `toEqual` assertion fails and the test also hangs/times out waiting on `releaseQuote`/`releaseExtended` gates that are never reached before timeout. (If it hangs past the 30s integration timeout instead of failing cleanly, that is still "fails" for this step — proceed to Step 3.)

- [ ] **Step 3: Parallelize the reads**

In `be/src/envioSync/runSyncV2.ts`, replace lines 170-187 (the pre-fetch `for` loop body) — currently:

```ts
    const existing = existingByToken.get(tokenAddress);
    const willBeRebuilt = !existing || (existing.sourceLogId === null && existing.launchBlock >= windowStart);
    if (!willBeRebuilt || metadataByToken.has(tokenAddress)) continue;
    metadataByToken.set(tokenAddress, await readV2TokenMetadata(rpcClient, event.tokenAddress));
    const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
    quoteAssetByToken.set(tokenAddress, knownQuoteAsset
      ? { address: event.pairToken, ...knownQuoteAsset }
      : await resolveV2QuoteAsset(event.pairToken, rpcClient));
    const extended = await readExtendedTokenMetadataOutcomes(rpcClient, event.tokenAddress);
    const timestamp: ReadOutcome<number> = rpcClient.getBlock
      ? await readLaunchTimestamp({ getBlock: rpcClient.getBlock.bind(rpcClient) }, row.blockNumber)
      : { state: 'pending', value: null, errorKind: 'unknown' };
    extendedByToken.set(tokenAddress, mapMetadataReadResults({ ...extended, timestamp }));
```

with:

```ts
    const existing = existingByToken.get(tokenAddress);
    const willBeRebuilt = !existing || (existing.sourceLogId === null && existing.launchBlock >= windowStart);
    if (!willBeRebuilt || metadataByToken.has(tokenAddress)) continue;
    const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
    // Independent RPC reads — no one needs another's result — started together and awaited as one
    // group, matching syncV1LegacyToReal's metadata+graduated+extended grouping. The known-native-ETH
    // fast path still makes zero RPC calls for the quote asset.
    const [metadata, quoteAsset, extended] = await Promise.all([
      readV2TokenMetadata(rpcClient, event.tokenAddress),
      knownQuoteAsset ? Promise.resolve({ address: event.pairToken, ...knownQuoteAsset }) : resolveV2QuoteAsset(event.pairToken, rpcClient),
      readExtendedTokenMetadataOutcomes(rpcClient, event.tokenAddress),
    ]);
    metadataByToken.set(tokenAddress, metadata);
    quoteAssetByToken.set(tokenAddress, quoteAsset);
    const timestamp: ReadOutcome<number> = rpcClient.getBlock
      ? await readLaunchTimestamp({ getBlock: rpcClient.getBlock.bind(rpcClient) }, row.blockNumber)
      : { state: 'pending', value: null, errorKind: 'unknown' };
    extendedByToken.set(tokenAddress, mapMetadataReadResults({ ...extended, timestamp }));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd be && npm run test:integration -- runSyncV2`
Expected: PASS, including the new test and the pre-existing "transient optional read failure"/"enqueues a feed-resolution job"/Critical-2 tests (required-field failure still rejects `syncV2ToReal`, since `Promise.all` rejects if any member rejects, same as the old sequential awaits).

- [ ] **Step 5: Commit**

```bash
git add be/src/envioSync/runSyncV2.ts be/src/envioSync/runSyncV2.integration.test.ts
git commit -m "perf: start Envio V2 sync's metadata/quote/extended RPC reads concurrently"
```

---

## Task 3: Migrate `launches.launch_timestamp` to bigint

**Files:**
- Modify: `be/src/db/schema.ts:150`
- Create: `be/drizzle/0028_*.sql` (generated)
- Test: `be/src/db/schema.migration.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `be/src/db/schema.migration.integration.test.ts`, a new `describe` block:

```ts
describe('launches.launch_timestamp is bigint (minor-quality-fixes spec)', () => {
  it('persists a value above the int4 maximum', async () => {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, source_log_id, name, symbol,
      token_decimals, platform, protocol_version, factory_address, deployer_address, launch_block,
      launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals,
      lifecycle_status, launch_timestamp)
      VALUES (4663,$1,$2,NULL,'BigTs','BigTs',18,'pons','v1',$1,$1,1,$3,9,$1,'ETH',18,'trading',5000000000)
      ON CONFLICT (chain_id, token_address) DO UPDATE SET launch_timestamp = excluded.launch_timestamp`,
    [token, sourceId, txHash]);
    const result = await pool.query('SELECT launch_timestamp FROM launches WHERE token_address = $1', [token]);
    expect(Number(result.rows[0].launch_timestamp)).toBe(5_000_000_000);
  });
});
```

(`5_000_000_000` exceeds int4's 2,147,483,647 maximum and would overflow/reject under the current `integer` column.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && npm run test:integration -- schema.migration`
Expected: FAIL — Postgres raises `integer out of range` for the `5000000000` literal against the current `integer` column.

- [ ] **Step 3: Change the Drizzle column type**

In `be/src/db/schema.ts:150`, change:

```ts
  launchTimestamp: integer('launch_timestamp'),
```

to:

```ts
  launchTimestamp: bigint('launch_timestamp', { mode: 'number' }),
```

(`bigint` is already imported at the top of the file.)

- [ ] **Step 4: Generate the migration**

Run: `cd be && npm run db:generate`
Expected: creates `be/drizzle/0028_<name>.sql` containing `ALTER TABLE "launches" ALTER COLUMN "launch_timestamp" SET DATA TYPE bigint;` (an int4→int8 widening — no existing values change, per spec). Read the generated file to confirm it contains only that one statement before proceeding.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd be && npm run test:integration -- schema.migration`
Expected: PASS — `vitest.integration.globalSetup.ts` applies the new migration to the local test DB automatically before the test runs.

- [ ] **Step 6: Run the full integration suite to confirm no regression**

Run: `cd be && npm run test:integration`
Expected: PASS. In particular `runSync.integration.test.ts`'s and `runSyncV2.integration.test.ts`'s `launchTimestamp` assertions (e.g. `expect(row.launchTimestamp).toBe(1_700_000_000)`) still pass unchanged — Drizzle's `bigint(..., { mode: 'number' })` maps the driver value back to a JS `number` on read and accepts a JS `number` on write, so no call site needs updating.

- [ ] **Step 7: Commit**

```bash
git add be/src/db/schema.ts be/drizzle/0028_*.sql be/drizzle/meta be/src/db/schema.migration.integration.test.ts
git commit -m "fix: widen launches.launch_timestamp to bigint so it survives past 2038"
```

---

## Task 4: Format each 52-week trade price once in `computeStats()`

**Files:**
- Modify: `be/src/api/store.ts:144-164`

- [ ] **Step 1: Write the failing test**

Add to `be/src/api/store.integration.test.ts` (near the other `computeStats`/52-week tests — search the file for `week52High` to find the right `describe` block and insert alongside):

```ts
  it('computes identical 52-week high/low and 1h/1d change from one formatting pass (no duplicate formatRational work)', async () => {
    // Regression guard for the dedup refactor: assert the externally-observable values are
    // unchanged, since formatRational is deterministic and a correct dedup cannot change output.
    const detail = await store.getLaunch(4663, goodToken);
    expect(detail?.week52High).not.toBeUndefined();
    expect(detail?.change1h).not.toBeUndefined();
  });
```

This is a thin regression pin (the real guard is behavioral: every existing `week52High`/`week52Low`/`change1h`/`change1d` test in this file must keep passing byte-for-byte after the refactor).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && npm run test:integration -- store`
Expected: This specific new assertion likely already passes against the unrefactored code (it is a smoke test, not a red/green pin for the dedup itself) — confirm instead by running the full existing 52-week/change suite now, recording it green, so Step 4 proves the refactor preserved it.

- [ ] **Step 3: Deduplicate the formatting**

In `be/src/api/store.ts`, replace the `let high...else...pricedTrades` block (lines ~118-163) — currently:

```ts
    let high: string | null;
    let low: string | null;
    let changeRows: Row[];
    if (cacheReady) {
      const extrema = await read52WeekHighLowFromCandles(pool, number(row.chain_id), string(row.token_address), nowSeconds);
      high = extrema.complete ? extrema.high : null;
      low = extrema.complete ? extrema.low : null;
      // Price changes need only the past day plus the last priced trade before its boundary.
      // This keeps a 52-week trade scan out of the cached path.
      const since1d = nowSeconds - 86_400;
      const [baseline, recent] = await Promise.all([
        pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
          FROM trades t JOIN venues v ON v.id = t.venue_id
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
            AND t.timestamp < $3 AND t.timestamp >= $4
            AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
          ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`,
        [number(row.chain_id), string(row.token_address), since1d, nowSeconds - 52 * 7 * 86_400]),
        pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
          FROM trades t JOIN venues v ON v.id = t.venue_id
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
            AND t.timestamp >= $3 AND t.timestamp <= $4
            AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
          ORDER BY t.block_number, t.log_index`,
        [number(row.chain_id), string(row.token_address), since1d, nowSeconds]),
      ]);
      changeRows = [...baseline.rows, ...recent.rows] as Row[];
    } else {
      // Until the historical candle backfill finishes, preserve the existing trade-based result.
      const since = nowSeconds - 52 * 7 * 86_400;
      const highLowResult = await pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
        FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true AND t.timestamp >= $3
          AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number, t.log_index`, [number(row.chain_id), string(row.token_address), since]);
      const prices = (highLowResult.rows as Row[]).map((priceRow) =>
        formatRational(BigInt(string(priceRow.price_numerator_raw)), BigInt(string(priceRow.price_denominator_raw)), 18));
      ({ high, low } = compute52WeekHighLow(prices.map((price) => ({ high: price, low: price }))));
      changeRows = highLowResult.rows as Row[];
    }
    const pricedTrades = changeRows.map((r) => ({
      timestamp: number(r.timestamp),
      price: formatRational(BigInt(string(r.price_numerator_raw)), BigInt(string(r.price_denominator_raw)), 18),
    }));
    const change1h = computePriceChange(pricedTrades, nowSeconds, 3600);
    const change1d = computePriceChange(pricedTrades, nowSeconds, 86400);
```

with:

```ts
    let high: string | null;
    let low: string | null;
    let pricedTrades: { timestamp: number; price: string }[];
    if (cacheReady) {
      const extrema = await read52WeekHighLowFromCandles(pool, number(row.chain_id), string(row.token_address), nowSeconds);
      high = extrema.complete ? extrema.high : null;
      low = extrema.complete ? extrema.low : null;
      // Price changes need only the past day plus the last priced trade before its boundary.
      // This keeps a 52-week trade scan out of the cached path.
      const since1d = nowSeconds - 86_400;
      const [baseline, recent] = await Promise.all([
        pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
          FROM trades t JOIN venues v ON v.id = t.venue_id
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
            AND t.timestamp < $3 AND t.timestamp >= $4
            AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
          ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`,
        [number(row.chain_id), string(row.token_address), since1d, nowSeconds - 52 * 7 * 86_400]),
        pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
          FROM trades t JOIN venues v ON v.id = t.venue_id
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
            AND t.timestamp >= $3 AND t.timestamp <= $4
            AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
          ORDER BY t.block_number, t.log_index`,
        [number(row.chain_id), string(row.token_address), since1d, nowSeconds]),
      ]);
      pricedTrades = [...baseline.rows, ...recent.rows].map((r: Row) => ({
        timestamp: number(r.timestamp),
        price: formatRational(BigInt(string(r.price_numerator_raw)), BigInt(string(r.price_denominator_raw)), 18),
      }));
    } else {
      // Until the historical candle backfill finishes, preserve the existing trade-based result.
      const since = nowSeconds - 52 * 7 * 86_400;
      const highLowResult = await pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
        FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true AND t.timestamp >= $3
          AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number, t.log_index`, [number(row.chain_id), string(row.token_address), since]);
      // Format once and reuse for both high/low and 1h/1d change — this branch used to format
      // every row twice (once into `prices`, once into `pricedTrades`).
      pricedTrades = (highLowResult.rows as Row[]).map((r) => ({
        timestamp: number(r.timestamp),
        price: formatRational(BigInt(string(r.price_numerator_raw)), BigInt(string(r.price_denominator_raw)), 18),
      }));
      ({ high, low } = compute52WeekHighLow(pricedTrades.map((t) => ({ high: t.price, low: t.price }))));
    }
    const change1h = computePriceChange(pricedTrades, nowSeconds, 3600);
    const change1d = computePriceChange(pricedTrades, nowSeconds, 86400);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd be && npm run test:integration -- store`
Expected: PASS — every existing `week52High`/`week52Low`/`change1h`/`change1d` assertion in `store.integration.test.ts` is unchanged (same deterministic `formatRational` inputs/outputs, just computed once).

- [ ] **Step 5: Commit**

```bash
git add be/src/api/store.ts be/src/api/store.integration.test.ts
git commit -m "perf: format each 52-week trade price once in computeStats instead of twice"
```

---

## Task 5: Lean launch-list response (omit `description`)

**Files:**
- Modify: `be/src/api/server.ts:11-29`
- Modify: `be/src/api/schemas.ts:5-29`
- Modify: `be/src/api/store.ts:47-69, 363-383, 391-421` (the `summary`, `listLaunches`, and `getLaunch` query/column lists), and the matching block inside `listLaunchesByVolume` (`~line 234`)
- Modify: `be/src/api/server.test.ts`
- Test: `be/src/api/store.integration.test.ts`
- Regenerate: `be/openapi.json` (via `npm run openapi:write`), `fe/src/api/schema.ts` (via `npm run generate:schema`)

**Interfaces:**
- Produces: `LaunchSummary` (server.ts) no longer has `description`; `LaunchDetail` gains its own `description: string | null`.

- [ ] **Step 1: Write the failing test**

Add to `be/src/api/store.integration.test.ts`, near the existing `listLaunches` tests:

```ts
  it('omits description from list items but keeps it on launch detail', async () => {
    await pool.query(`UPDATE launches SET description = $1 WHERE token_address = $2`, ['List vs detail description', goodToken]);
    try {
      const list = await store.listLaunches({ limit: 50, chainId: 4663 });
      const item = list.items.find((i) => i.tokenAddress === goodToken);
      expect(item).not.toHaveProperty('description');
      const detail = await store.getLaunch(4663, goodToken);
      expect(detail?.description).toBe('List vs detail description');
    } finally {
      await pool.query(`UPDATE launches SET description = NULL WHERE token_address = $1`, [goodToken]);
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && npm run test:integration -- store`
Expected: FAIL — today's `listLaunches` items include `description: null` (or the set value), so `not.toHaveProperty('description')` fails.

- [ ] **Step 3: Split the types**

In `be/src/api/server.ts`, remove `description` from `LaunchSummary` (line 21) and add it to `LaunchDetail`:

```ts
export interface LaunchSummary {
  chainId: number; tokenAddress: string; name: string; symbol: string; platform: string; protocolVersion: string;
  quoteAsset: { address: string; symbol: string; decimals: number }; lifecycleStatus: string;
  officialVolume24h: string | null; coverageStatus: string;
  fdvUsd: string | null; marketCapUsd: string | null;
  tvlUsd: string | null; tvlBasis: string | null; tvlBlockNumber: string | null;
  tvlPriceSource: string | null; tvlPriceUpdatedAt: number | null; tvlUnavailableReason: string | null;
  week52High: string | null; week52Low: string | null;
  logoUri: string | null; websiteUrl: string | null; twitterUrl: string | null;
  launchTimestamp: string | null; change1h: string | null; change1d: string | null;
  officialVolume24hUsd: string | null; officialVolume24hUsdApprox: boolean;
}
export interface LaunchDetail extends LaunchSummary {
  description: string | null;
  officialVenues: readonly { id: string; kind: string; ref: string; effectiveFromBlock: string; effectiveToBlock: string | null }[];
  priceQuote: string | null;
  priceStale: boolean;
}
```

- [ ] **Step 4: Split the OpenAPI schemas**

In `be/src/api/schemas.ts`, remove the `description` line from `launchSummary.properties` and add it as its own property on `launchDetail`:

```ts
export const launchSummary = { type: 'object', properties: {
  chainId: { type: 'integer' }, tokenAddress: { type: 'string' }, name: { type: 'string' }, symbol: { type: 'string' },
  platform: { type: 'string' }, protocolVersion: { type: 'string' }, quoteAsset,
  lifecycleStatus: { type: 'string' }, officialVolume24h: { type: 'string', nullable: true }, coverageStatus: { type: 'string' },
  fdvUsd: { type: 'string', nullable: true }, marketCapUsd: { type: 'string', nullable: true },
  tvlUsd: { type: 'string', nullable: true }, tvlBasis: { type: 'string', nullable: true },
  tvlBlockNumber: { type: 'string', nullable: true }, tvlPriceSource: { type: 'string', nullable: true },
  tvlPriceUpdatedAt: { type: 'integer', nullable: true }, tvlUnavailableReason: { type: 'string', nullable: true },
  week52High: { type: 'string', nullable: true }, week52Low: { type: 'string', nullable: true },
  logoUri: { type: 'string', nullable: true },
  websiteUrl: { type: 'string', nullable: true }, twitterUrl: { type: 'string', nullable: true },
  launchTimestamp: { type: 'string', nullable: true },
  change1h: { type: 'string', nullable: true }, change1d: { type: 'string', nullable: true },
  officialVolume24hUsd: { type: 'string', nullable: true }, officialVolume24hUsdApprox: { type: 'boolean' },
} } as const;

export const launchDetail = { type: 'object', properties: {
  ...launchSummary.properties,
  description: { type: 'string', nullable: true },
  officialVenues: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, kind: { type: 'string' }, ref: { type: 'string' },
    effectiveFromBlock: { type: 'string' }, effectiveToBlock: { type: 'string', nullable: true },
  } } },
  priceQuote: { type: 'string', nullable: true },
  priceStale: { type: 'boolean' },
} } as const;
```

- [ ] **Step 5: Remove `description` from `summary()` and add it only in `getLaunch()`**

In `be/src/api/store.ts`, remove this line from `summary()` (around line 60):

```ts
    description: row.description === null || row.description === undefined ? null : string(row.description),
```

Then in `getLaunch()` (around line 413), change:

```ts
      return { ...summary(row, complete, stats), officialVenues: venueRows.rows.map((venue: Row) => ({
```

to:

```ts
      return { ...summary(row, complete, stats),
        description: row.description === null || row.description === undefined ? null : string(row.description),
        officialVenues: venueRows.rows.map((venue: Row) => ({
```

(keep the rest of that return statement's closing exactly as it already is — this only adds one field to the object literal).

- [ ] **Step 6: Stop selecting `description` in the two list queries**

In `be/src/api/store.ts`'s `listLaunches` (around line 369), replace:

```sql
        SELECT l.*, s.status AS source_status, l.launch_block AS block_number,
```

with:

```sql
        SELECT l.chain_id, l.token_address, l.name, l.symbol, l.platform, l.protocol_version, l.token_decimals,
          l.factory_address, l.quote_asset_address, l.quote_asset_symbol, l.quote_asset_decimals, l.lifecycle_status,
          l.v4_pool_fee, l.v4_tick_spacing, l.logo_uri, l.website_url, l.twitter_url, l.launch_timestamp,
          s.status AS source_status, l.launch_block AS block_number,
```

(keep every line after it — `l.launch_tx_hash AS tx_hash, ...` through the `WHERE`/`ORDER BY`/params — unchanged).

In `listLaunchesByVolume`'s base query (around line 232), replace:

```sql
      SELECT l.*, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
```

with:

```sql
      SELECT l.chain_id, l.token_address, l.name, l.symbol, l.platform, l.protocol_version, l.token_decimals,
        l.factory_address, l.quote_asset_address, l.quote_asset_symbol, l.quote_asset_decimals, l.lifecycle_status,
        l.v4_pool_fee, l.v4_tick_spacing, l.logo_uri, l.website_url, l.twitter_url, l.launch_timestamp,
        l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
```

(keep the rest — `${launchCoverageSql(5)} AS launch_coverage_complete, ...` — unchanged. `getLaunch`'s own query keeps its `l.*`, since the detail response still needs `description`.)

- [ ] **Step 7: Run it to verify it passes**

Run: `cd be && npm run test:integration -- store`
Expected: PASS. Also run `cd be && npm run typecheck` to confirm `LaunchSummary`/`LaunchDetail` consumers (routes, tests) still typecheck.

- [ ] **Step 8: Update the unit-test mock in `server.test.ts`**

In `be/src/api/server.test.ts`, split the single `launch` fixture into a list-shaped summary and a detail-shaped object:

```ts
const launchSummary = {
  chainId: 4663, tokenAddress: address, name: 'Example', symbol: 'EX', platform: 'pons', protocolVersion: 'v2',
  quoteAsset: { address: '0x2222222222222222222222222222222222222222', symbol: 'USDG', decimals: 6 },
  lifecycleStatus: 'trading', officialVolume24h: null, coverageStatus: 'backfilling',
  fdvUsd: null, marketCapUsd: null, tvlUsd: null, tvlBasis: null, tvlBlockNumber: null,
  tvlPriceSource: null, tvlPriceUpdatedAt: null, tvlUnavailableReason: 'unavailable',
  week52High: null, week52Low: null,
  logoUri: null, websiteUrl: null, twitterUrl: null, launchTimestamp: null,
  change1h: null, change1d: null,
  officialVolume24hUsd: null, officialVolume24hUsdApprox: false,
};
const launch = { ...launchSummary, description: null };
```

Then change `listLaunches: async () => ({ items: [launch], nextCursor: null })` (and every other `listLaunches`/`calls.push`-style stub returning `[launch]` in this file) to return `[launchSummary]` instead, and change every `expect(list.json()).toEqual({ items: [launch], ... })`-style assertion on a list endpoint response to expect `[launchSummary]`. Leave `getLaunch`'s stub and the `/v1/launches/:chainId/:tokenAddress` response assertions using `launch` (the detail shape) unchanged.

- [ ] **Step 9: Update the FE unit fixture**

In `fe/src/features/launches/launch-list.test.tsx`, remove the `description: null,` line (line 29) from the `launch()` fixture — `LaunchSummary` will no longer have that property once the schema is regenerated (Step 10), so TypeScript would flag it as excess.

- [ ] **Step 10: Regenerate OpenAPI and frontend types**

Run: `cd be && npm run openapi:write`
Run: `cd fe && npm run generate:schema`
Expected: `be/openapi.json`'s `/v1/launches` list-item schema no longer has `description`; its `/v1/launches/{chainId}/{tokenAddress}` schema still does. `fe/src/api/schema.ts` regenerates to match. Run `cd fe && npm run check:schema` to confirm the checked-in file matches.

- [ ] **Step 11: Typecheck and test both sides**

Run: `cd be && npm run typecheck && npm run test`
Run: `cd fe && npm run typecheck && npm run test`
Expected: PASS. If `fe`'s typecheck flags any other file destructuring `description` off a `LaunchSummary`-typed value, fix it there (the Task-1 exploration found only `launch-detail.tsx`'s `detail.description`, which reads from `LaunchDetail`, not `LaunchSummary`, so none are expected).

- [ ] **Step 12: Commit**

```bash
git add be/src/api/server.ts be/src/api/schemas.ts be/src/api/store.ts be/src/api/server.test.ts be/src/api/store.integration.test.ts be/openapi.json fe/src/api/schema.ts fe/src/features/launches/launch-list.test.tsx
git commit -m "perf: drop description from the launch-list API response, keep it on launch detail"
```

---

## Task 6: Harden `copyAddress()` against a missing/rejecting Clipboard API

**Files:**
- Modify: `fe/src/features/launch/about-section.tsx`
- Create: `fe/src/features/launch/about-section.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `fe/src/features/launch/about-section.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutSection } from './about-section';

const baseProps = {
  description: null as string | null,
  tokenAddress: '0x1111111111111111111111111111111111111111',
  explorerUrl: 'https://robinhoodchain.blockscout.com/token/0x1111111111111111111111111111111111111111',
  websiteUrl: null as string | null,
  twitterUrl: null as string | null,
};

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true });
}

describe('AboutSection copy-address control', () => {
  afterEach(() => {
    setClipboard(undefined);
  });

  it('shows a manual-copy fallback when the Clipboard API does not exist', async () => {
    setClipboard(undefined);
    render(<AboutSection {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(baseProps.tokenAddress);
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('shows a manual-copy fallback when the write is rejected', async () => {
    setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
    render(<AboutSection {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(baseProps.tokenAddress);
  });

  it('shows Copied after a successful write, and clears it on the next attempt', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<AboutSection {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
    });
    expect(writeText).toHaveBeenCalledWith(baseProps.tokenAddress);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npm test -- about-section`
Expected: FAIL — today's `copyAddress()` calls `navigator.clipboard.writeText` unconditionally, throwing synchronously on the missing-API case (inside an unhandled async function) and never rendering a `role="alert"` fallback in either failing case.

- [ ] **Step 3: Rewrite `copyAddress()` and its markup**

In `fe/src/features/launch/about-section.tsx`, replace the `copied` state and `copyAddress` function:

```tsx
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  async function copyAddress() {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    setCopyState('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(tokenAddress);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 2000);
  }
```

Add `useEffect, useRef` to the existing `useState` import line. Then replace the copy button and its surrounding markup:

```tsx
        <button
          type="button"
          onClick={copyAddress}
          aria-label={copyState === 'copied' ? 'Copied' : 'Copy token address'}
          className="rounded-full bg-accent px-3 py-1 text-sm text-accent-foreground hover:bg-accent/80"
        >
          {copyState === 'copied' ? 'Copied' : `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`}
        </button>
        {copyState === 'error' && (
          <span role="alert" className="text-sm text-destructive">
            Could not copy automatically — select to copy: <span className="select-all font-mono">{tokenAddress}</span>
          </span>
        )}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npm test -- about-section`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fe/src/features/launch/about-section.tsx fe/src/features/launch/about-section.test.tsx
git commit -m "fix: handle a missing or rejecting Clipboard API in the About section's copy control"
```

---

## Task 7: Validate `websiteUrl`/`twitterUrl`/`logoUri` at the rendering boundary

**Files:**
- Create: `fe/src/api/url.ts`
- Create: `fe/src/api/url.test.ts`
- Modify: `fe/src/api/ipfs.ts`
- Modify: `fe/src/features/launch/about-section.tsx`
- Test: `fe/src/features/launch/about-section.test.tsx` (extend)

- [ ] **Step 1: Write the failing URL-validator test**

Create `fe/src/api/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './url';

describe('isHttpUrl', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com/path?x=1', true],
    ['https://x.com/example', true],
    ['data:text/html,<script>alert(1)</script>', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    ['relative/path', false],
    ['ftp://example.com', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(isHttpUrl(value)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npm test -- url.test`
Expected: FAIL — `./url` does not exist yet.

- [ ] **Step 3: Implement `isHttpUrl`**

Create `fe/src/api/url.ts`:

```ts
// websiteUrl/twitterUrl/logoUri all come from unverified onchain token metadata that the token
// creator controls — accept only http(s) with a real hostname, never data:/javascript:/relative.
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npm test -- url.test`
Expected: PASS.

- [ ] **Step 5: Write the failing logo-resolution test**

Add to `fe/src/features/launches/token-logo.test.tsx` (find its existing `describe` block and add nearby — check the file first for its exact import/render helper names before matching style):

```tsx
  it('falls back to the placeholder for a malformed logo URI', () => {
    render(<TokenLogo logoUri="javascript:alert(1)" symbol="TKA" />);
    expect(screen.queryByAltText('Token logo')).not.toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('falls back to the placeholder for an empty ipfs:// CID', () => {
    render(<TokenLogo logoUri="ipfs://" symbol="TKA" />);
    expect(screen.queryByAltText('Token logo')).not.toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd fe && npm test -- token-logo`
Expected: FAIL — `resolveLogoUrl` currently returns any non-`ipfs://` string as-is (including `javascript:...`) and returns `IPFS_GATEWAY` unchanged (no CID) for `ipfs://`.

- [ ] **Step 7: Validate inside `resolveLogoUrl`**

In `fe/src/api/ipfs.ts`, add the import and update the function:

```ts
import { isHttpUrl } from './url';

const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

export function resolveLogoUrl(uri: string | null): string | null {
  if (uri === null) return null;
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice('ipfs://'.length);
    return cid.length > 0 ? IPFS_GATEWAY + cid : null;
  }
  return isHttpUrl(uri) ? uri : null;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd fe && npm test -- token-logo`
Expected: PASS.

- [ ] **Step 9: Write the failing About-section pill tests**

Add to `fe/src/features/launch/about-section.test.tsx`:

```tsx
describe('AboutSection website/Twitter link validation', () => {
  it('hides the website pill for an invalid URL and shows it for a valid one', () => {
    const { rerender } = render(<AboutSection {...baseProps} websiteUrl="javascript:alert(1)" />);
    expect(screen.queryByRole('link', { name: 'Website' })).not.toBeInTheDocument();
    rerender(<AboutSection {...baseProps} websiteUrl="https://example.com" />);
    expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute('href', 'https://example.com');
  });

  it('keeps any valid http(s) Twitter URL without requiring an x.com/twitter.com host', () => {
    render(<AboutSection {...baseProps} twitterUrl="https://some-other-domain.example/profile" />);
    expect(screen.getByRole('link', { name: 'Twitter' })).toHaveAttribute('href', 'https://some-other-domain.example/profile');
  });

  it('hides the Twitter pill for a malformed URL', () => {
    render(<AboutSection {...baseProps} twitterUrl="not a url" />);
    expect(screen.queryByRole('link', { name: 'Twitter' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `cd fe && npm test -- about-section`
Expected: FAIL — today's pills render for any non-null `websiteUrl`/`twitterUrl`, valid or not.

- [ ] **Step 11: Validate inside `AboutSection`**

In `fe/src/features/launch/about-section.tsx`, add `import { isHttpUrl } from '@/api/url';` and change:

```tsx
        {websiteUrl !== null && <Pill href={websiteUrl}>Website</Pill>}
        {twitterUrl !== null && <Pill href={twitterUrl}>Twitter</Pill>}
```

to:

```tsx
        {websiteUrl !== null && isHttpUrl(websiteUrl) && <Pill href={websiteUrl}>Website</Pill>}
        {twitterUrl !== null && isHttpUrl(twitterUrl) && <Pill href={twitterUrl}>Twitter</Pill>}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `cd fe && npm test -- about-section token-logo url.test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add fe/src/api/url.ts fe/src/api/url.test.ts fe/src/api/ipfs.ts fe/src/features/launch/about-section.tsx fe/src/features/launch/about-section.test.tsx fe/src/features/launches/token-logo.test.tsx
git commit -m "fix: validate onchain website/Twitter/logo URLs before rendering them as links or images"
```

---

## Task 8: Derive the About section's explorer link from the registered chain only

**Files:**
- Modify: `fe/src/features/launch/about-section.tsx`
- Modify: `fe/src/features/launch/launch-detail.tsx:92-98`
- Test: `fe/src/features/launch/launch-detail.test.tsx`

- [ ] **Step 1: Write the failing test**

In `fe/src/features/launch/launch-detail.test.tsx`, find the test(s) rendering `<LaunchDetail>` with an unknown `chainId` (search for `chainId:` overrides), or add a new one near the About-section tests:

```tsx
  it('hides the About section explorer pill for a chain with no registered explorer', () => {
    render(<LaunchDetail detail={detail({ chainId: 999999 })} trades={null} candles={null} />);
    expect(screen.queryByRole('link', { name: /explorer/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npm test -- launch-detail`
Expected: FAIL — today's `explorerUrl={\`${explorerBase ?? 'https://robinhoodchain.blockscout.com'}/token/...\`}` always renders an explorer pill, even for an unregistered chain.

- [ ] **Step 3: Make `explorerUrl` optional and stop substituting Robinhood**

In `fe/src/features/launch/about-section.tsx`, change the props interface and the pill:

```ts
export interface AboutSectionProps {
  description: string | null;
  tokenAddress: string;
  explorerUrl?: string;
  websiteUrl: string | null;
  twitterUrl: string | null;
}
```

```tsx
export function AboutSection({ description, tokenAddress, explorerUrl, websiteUrl, twitterUrl }: AboutSectionProps) {
```

```tsx
        {explorerUrl !== undefined && <Pill href={explorerUrl}>Robinhood Explorer</Pill>}
```

In `fe/src/features/launch/launch-detail.tsx`, change:

```tsx
              explorerUrl={`${explorerBase ?? 'https://robinhoodchain.blockscout.com'}/token/${detail.tokenAddress}`}
```

to:

```tsx
              explorerUrl={explorerBase ? `${explorerBase}/token/${detail.tokenAddress}` : undefined}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npm test -- launch-detail`
Expected: PASS. Also confirm the existing chain-4663 test (the one asserting the explorer pill/link IS present) still passes.

- [ ] **Step 5: Commit**

```bash
git add fe/src/features/launch/about-section.tsx fe/src/features/launch/launch-detail.tsx fe/src/features/launch/launch-detail.test.tsx
git commit -m "fix: hide the About section explorer link for a chain with no registered explorer"
```

---

## Task 9: Show "Show more" only when the description actually overflows

**Files:**
- Modify: `fe/src/features/launch/about-section.tsx`
- Test: `fe/src/features/launch/about-section.test.tsx` (extend)
- Modify: `fe/e2e/mock-api.ts`
- Modify: `fe/e2e/launch-detail.spec.ts`

- [ ] **Step 1: Write the failing jsdom tests**

Add to `fe/src/features/launch/about-section.test.tsx`:

```tsx
describe('AboutSection description overflow detection', () => {
  let scrollHeight = 0;
  let clientHeight = 0;

  beforeEach(() => {
    scrollHeight = 0;
    clientHeight = 0;
    Object.defineProperty(HTMLParagraphElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(HTMLParagraphElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight });
  });

  it('renders no paragraph or toggle for a null description', () => {
    render(<AboutSection {...baseProps} description={null} />);
    expect(screen.queryByText(/show more/i)).not.toBeInTheDocument();
  });

  it('renders no paragraph or toggle for a whitespace-only description', () => {
    render(<AboutSection {...baseProps} description={'   \n  '} />);
    expect(screen.queryByText(/show more/i)).not.toBeInTheDocument();
  });

  it('does not show Show more when the collapsed paragraph does not overflow', () => {
    scrollHeight = 40;
    clientHeight = 60;
    render(<AboutSection {...baseProps} description="Short description." />);
    expect(screen.getByText('Short description.')).toBeInTheDocument();
    expect(screen.queryByText(/show more/i)).not.toBeInTheDocument();
  });

  it('shows Show more when the collapsed paragraph overflows, and toggles to Show less', () => {
    scrollHeight = 120;
    clientHeight = 60;
    render(<AboutSection {...baseProps} description="A very long description that wraps past three lines." />);
    const toggle = screen.getByRole('button', { name: /show more/i });
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show less/i }));
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  });

  it('preserves manual newlines via whitespace-pre-wrap', () => {
    scrollHeight = 40;
    clientHeight = 60;
    render(<AboutSection {...baseProps} description={'Line one\nLine two'} />);
    const paragraph = screen.getByText((_, node) => node?.textContent === 'Line one\nLine two');
    expect(paragraph).toHaveClass('whitespace-pre-wrap');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npm test -- about-section`
Expected: FAIL — today's component shows "Show more" for every non-null description unconditionally, and renders a paragraph/button for whitespace-only text.

- [ ] **Step 3: Implement overflow-gated expansion**

In `fe/src/features/launch/about-section.tsx`, add `useLayoutEffect, useRef` to the React import, add state/ref/effect, and gate the block on trimmed content:

```tsx
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const hasDescription = description !== null && description.trim() !== '';

  useLayoutEffect(() => {
    if (!hasDescription || expanded) return;
    const node = paragraphRef.current;
    if (!node) return;
    const measure = () => setCanExpand(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [description, hasDescription, expanded]);
```

Then replace the description block:

```tsx
      {hasDescription && (
        <div>
          <p
            ref={paragraphRef}
            className={cn('whitespace-pre-wrap text-sm text-muted-foreground', !expanded && 'line-clamp-3')}
          >
            {description}
          </p>
          {(canExpand || expanded) && (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="text-sm font-medium text-primary hover:underline">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npm test -- about-section`
Expected: PASS.

- [ ] **Step 5: Add a real-browser overflow check**

In `fe/e2e/mock-api.ts`, change `description: null,` (line 30) to a long string guaranteed to overflow three lines at any realistic viewport, e.g.:

```ts
  description:
    'E2E Launch is a long-form test description written specifically to exceed three lines of wrapped ' +
    'text at both narrow mobile viewports and wide desktop viewports, so the Playwright suite can verify ' +
    'the real browser line-clamp overflow detection end to end, independent of the jsdom unit tests that ' +
    'mock scrollHeight and clientHeight instead of performing real layout.',
```

In `fe/e2e/launch-detail.spec.ts`, add a new test:

```ts
test('shows and expands Show more for a long description at both mobile and desktop widths', async ({ page }) => {
  for (const viewport of [{ width: 375, height: 800 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    const toggle = page.getByRole('button', { name: /show more/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('button', { name: /show less/i })).toBeVisible();
  }
});
```

- [ ] **Step 6: Run the e2e suite**

Run: `cd fe && npm run test:e2e -- launch-detail`
Expected: PASS. (If the project's Playwright config requires a build/start step first, run whatever `npm run` script the existing e2e tests document — check `fe/package.json`'s `e2e:*` scripts — before this command.)

- [ ] **Step 7: Commit**

```bash
git add fe/src/features/launch/about-section.tsx fe/src/features/launch/about-section.test.tsx fe/e2e/mock-api.ts fe/e2e/launch-detail.spec.ts
git commit -m "fix: only show About section's Show more control when the description actually overflows"
```

---

## Task 10: Visible mobile labels for bare launch-list metrics

**Files:**
- Modify: `fe/src/features/launches/launch-list.tsx:210-227`
- Modify: `fe/src/features/launches/launch-list.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `fe/src/features/launches/launch-list.test.tsx`, near the other metric-rendering tests:

```tsx
  it('shows a visible label next to each metric value for mobile layouts', () => {
    render(
      <LaunchList
        page={{ items: [launch({ fdvUsd: '1000', officialVolume24h: '50', tvlUsd: '200', change1h: '12.5', change1d: '-5' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    const row = within(table).getAllByRole('row')[1];
    expect(within(row).getByText('FDV')).toBeInTheDocument();
    expect(within(row).getByText('24H volume')).toBeInTheDocument();
    expect(within(row).getByText('Liquidity')).toBeInTheDocument();
    expect(within(row).getByText('1H %')).toBeInTheDocument();
    expect(within(row).getByText('1D %')).toBeInTheDocument();
    expect(within(row).getByText('Age')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fe && npm test -- launch-list`
Expected: FAIL — today's metric cells render only the bare value, no label text.

- [ ] **Step 3: Add `md:hidden` labels to each metric cell**

In `fe/src/features/launches/launch-list.tsx`, replace the FDV through Age cells (lines 210-227):

```tsx
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">FDV</span>
                  <span className="font-mono">{formatUsd(launch.fdvUsd)}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">24H volume</span>
                  <span className="font-mono" title={formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}>
                    {launch.officialVolume24hUsd !== null ? `~${formatUsd(launch.officialVolume24hUsd)}` : formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
                  </span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Liquidity</span>
                  <span className="font-mono" title={tvlTooltip(launch)}>{formatUsd(launch.tvlUsd)}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1H %</span>
                  <span className={cn('font-mono', change1h.className)}>{change1h.text}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1D %</span>
                  <span className={cn('font-mono', change1d.className)}>{change1d.text}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Age</span>
                  <span className="text-muted-foreground">{formatAge(launch.launchTimestamp)}</span>
                </div>
```

(`getNodeText` in `@testing-library/dom` only reads an element's *direct* text-node children, not nested elements' text, so each label `<span>` and value `<span>` are matched independently by `getByText` — the outer `role="cell"` div itself has no direct text and is never a candidate match. This is why every existing `getByText('$1000')`/`getByText('+12.5%')`/`.toHaveAttribute('title', ...)`-style assertion in this file keeps working unchanged.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd fe && npm test -- launch-list`
Expected: PASS, including every pre-existing test in the file (FDV, TVL/title, 1H/1D/Age values, null-dash rendering).

- [ ] **Step 5: Commit**

```bash
git add fe/src/features/launches/launch-list.tsx fe/src/features/launches/launch-list.test.tsx
git commit -m "fix: show visible metric labels on mobile launch cards instead of bare values"
```

---

## Task 11: Rewrite the detail-page e2e trading-control assertion

**Files:**
- Modify: `fe/e2e/launch-detail.spec.ts:30-38`

- [ ] **Step 1: Replace the test**

In `fe/e2e/launch-detail.spec.ts`, replace the existing test:

```ts
test('shows no wallet-connect or trade-execution controls on the detail page', async ({ page }) => {
  // Scoped to <main> (AppShell's content landmark) so Next's own dev-mode toolbar button,
  // which lives outside it, is not mistaken for an in-app trading/wallet control. The About
  // section's own "copy address"/"show more" buttons are legitimate non-wallet controls (added
  // this session) — matched by name instead of asserting zero buttons on the page.
  const appContent = page.getByRole('main');
  await expect(appContent.getByRole('button', { name: /wallet|connect|buy|sell|trade|swap/i })).toHaveCount(0);
  await expect(appContent.getByText(/wallet|connect wallet|kết nối ví/i)).toHaveCount(0);
});
```

with:

```ts
test('the header offers wallet connection while the read-only detail content has no trade-execution controls', async ({ page }) => {
  // <header> is a direct child of the page's top-level wrapper (not nested in <main>), so it has
  // the implicit 'banner' landmark role — this is where AppShell renders WalletControl.
  await expect(page.getByRole('banner').getByRole('button', { name: /connect wallet/i })).toBeVisible();

  // <main> is the read-only detail content. About's own copy-address/show-more/show-less buttons
  // are legitimate utility controls and must stay allowed; only buy/sell/swap execution verbs are
  // forbidden here — unlike a broader "trade" substring, which would wrongly flag a future
  // non-executing label like a "View trade" link in the trade-history table.
  const appContent = page.getByRole('main');
  await expect(appContent.getByRole('button', { name: /buy|sell|swap/i })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd fe && npm run test:e2e -- launch-detail`
Expected: PASS — `WalletControl` renders "Connect wallet" in the header (not inside `<main>`), and no button in `<main>` has a buy/sell/swap name.

- [ ] **Step 3: Commit**

```bash
git add fe/e2e/launch-detail.spec.ts
git commit -m "test: assert the detail page's trading-control absence directly instead of by broad name pattern"
```

---

## Final verification

- [ ] Run `cd be && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run openapi:check`
- [ ] Run `cd fe && npm run typecheck && npm run lint && npm run test && npm run check:schema && npm run build`
- [ ] Run `cd fe && npm run test:e2e` (full suite, not just `launch-detail`) to confirm no cross-spec regression from the mock-api description change (Task 9) or the about-section rewrite (Tasks 6-9).
- [ ] Re-read the spec's "Verification and boundaries" section and confirm nothing in this batch touched USD-ranking logic, the legacy RPC indexer, or performed a live/Supabase migration.
