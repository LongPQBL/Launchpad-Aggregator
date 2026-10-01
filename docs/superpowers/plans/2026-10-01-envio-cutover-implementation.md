# Envio Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Envio sync layer (`be/src/envioSync/`) capable of writing directly into the real `launches`/`venues`/`trades`/`lifecycle_transitions` tables that the API/FE read, then execute the one-time cutover that replaces the RPC-scan indexer (`be/src/cli/runFactoryIndexer.ts`) with Envio as the sole data source.

**Architecture:** Add on-chain metadata enrichment (reusing the RPC-scan indexer's own tested metadata-read functions) to close the NOT-NULL gap on `name`/`symbol`/quote-asset fields; run an additive schema migration that relaxes `sourceLogId` to nullable, fixes `lifecycle_transitions`' primary key, and adds `launches.launchLogIndex` (closing a real `raw_logs`-dependency bug in the launch-list API found while planning); add a shared reorg-safety mechanism (delete-and-rescan a recent block window) since HyperIndex only rolls back its own raw tables automatically, not this sync layer's derived output; add new functions that write the sync layer's already-correct business logic into the real tables instead of the staging tables; wire the CLI to pick a target; then execute the cutover procedure itself as a separate, explicitly-gated final task.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, viem, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-envio-cutover-design.md` (supersedes mục 5-8 of `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md`).

## Global Constraints

- Node.js >=24, TypeScript, Drizzle ORM, viem — match the existing `be/` stack, no new dependencies.
- `null` means unavailable — never fake a value (metadata enrichment failures throw, they never write a placeholder string).
- Every write stays idempotent (`onConflictDoNothing` / explicit existence checks) — re-running a cycle never duplicates data.
- Migrations are additive only — never drop a column, never break a row the RPC-scan indexer already wrote.
- Vietnamese for user-facing copy/docs; English for code identifiers, tests, comments, API fields, filenames (existing project convention).
- Work directly on `main`, no worktree (CLAUDE.md: solo developer).
- Task 10 (the actual cutover: stopping the live indexer process, running the migration against the live DB, flipping the sync loop's write target) is explicitly **not** auto-executed with the rest — it is a hard stop requiring the user's fresh go-ahead at that point in the session, per CLAUDE.md's rule on side effects to live-serving infrastructure. Tasks 1-9 are ordinary code changes with no live side effects and may proceed under existing automation authorization.

## Review Focus

- **A quote asset that is a real ERC20 (not ETH, not already known) must get its real decimals via RPC, never a faked default.** `resolveV2QuoteAsset`'s zero-address branch is free; every other pair token needs a live `readContract` call. A test must cover a non-ETH pair token and assert the RPC was actually called (not skipped).
- **A launch that the RPC-scan indexer already wrote to the real table must not error or duplicate when the Envio sync layer encounters it again.** `onConflictDoNothing` plus a metadata-call skip for already-present tokens must both hold — test with a pre-seeded real `launches` row sharing a token address with an Envio raw launch.
- **The reorg-safety delete must never remove a row outside its own window for an old token with recent activity.** A token launched far in the past with a trade inside the current reorg window must keep its `launches` row and its old, out-of-window trades untouched — only in-window `trades` rows get deleted and rescanned. This is the cascade-deletion bug flagged in the spec (mục 4) — a test must seed exactly this shape and assert the old trade survives.
- **`listLaunches`' pagination must produce the same order and same page boundaries before and after removing the `raw_logs` join**, for rows that still have a real `sourceLogId` — a regression here silently breaks FE pagination for every existing launch, not just new Envio ones.
- **A launch coverage check for a V2 token with a graduated V4 pool must resolve the per-pool `pons-v2-v4:<poolId>` source id correctly**, not the static `pons-v2-v4` string `transformV4.ts` currently assigns — a source id mismatch here makes `coverageStatus` wrong (stuck on `backfilling`) for every graduated token, invisibly, with no error anywhere.

---

### Task 1: RPC metadata enrichment for V1-legacy launches

**Files:**
- Modify: `be/src/envioSync/runSync.ts`
- Test: `be/src/envioSync/runSync.test.ts` (create — no existing unit test file for this module; `runSync.integration.test.ts` already exists and stays separate)

**Interfaces:**
- Consumes: `readV1TokenMetadata(client, token)` from `be/src/launchpads/pons/v1/state.ts` (returns `{ name, symbol, decimals, liquidityPool }`), `createRobinhoodPublicClient(httpUrl)` from `be/src/chains/robinhood.ts`.
- Produces: `syncV1LegacyOnce` gains an optional 4th parameter `rpcClient: V1ReadClient` (default: a real client built from `RH_HTTP_RPC_URL`), used by Task 6's real-table variant and by tests.

- [ ] **Step 1: Write the failing test for "new launch gets real metadata via RPC"**

```typescript
// be/src/envioSync/runSync.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

// A fake appDb/envioPool pair would require the full Drizzle+pg machinery this module needs at
// runtime; instead, test the one new piece of behavior (the RPC client is actually consulted for a
// token with no stored metadata yet) directly against a minimal reproduction of the selection logic,
// mirroring the existing project convention of unit-testing pure decode/hydrate functions and letting
// runSync.integration.test.ts cover the full DB-backed flow. See Step 3 for where this plugs in.
import { readV1TokenMetadata } from '../launchpads/pons/v1/state.js';

describe('syncV1LegacyOnce RPC metadata enrichment', () => {
  it('calls readV1TokenMetadata for a token with no existing real/staging row', async () => {
    const calls: Address[] = [];
    const client = {
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        calls.push(address);
        if (functionName === 'name') return 'Test Token';
        if (functionName === 'symbol') return 'TEST';
        if (functionName === 'decimals') return 18;
        if (functionName === 'liquidityPool') return '0x1111111111111111111111111111111111111111';
        throw new Error(`unexpected functionName ${functionName}`);
      },
    };
    const token = '0x2222222222222222222222222222222222222222' as Address;
    const metadata = await readV1TokenMetadata(client, token);
    expect(calls).toEqual([token, token, token, token]);
    expect(metadata).toEqual({ name: 'Test Token', symbol: 'TEST', decimals: 18, liquidityPool: '0x1111111111111111111111111111111111111111' });
  });
});
```

- [ ] **Step 2: Run it to verify it passes (this step pins the mock-client contract Step 3's real integration will rely on; `readV1TokenMetadata` itself already exists and is already tested — this step is not RED, it's a contract pin)**

Run: `cd be && npx vitest run src/envioSync/runSync.test.ts`
Expected: PASS, 1/1 — confirms the exact `readContract` call shape `runSync.ts` must use.

- [ ] **Step 3: Modify `runSync.ts` to enrich new launches and skip RPC for already-synced ones**

Replace the full contents of `be/src/envioSync/runSync.ts` with:

```typescript
import type { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import type { Address } from 'viem';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { hydrateV1Launch } from '../launchpads/pons/v1/adapter.js';
import { readV1TokenMetadata, type V1ReadClient } from '../launchpads/pons/v1/state.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { envioRawLaunchToEvent, hydrateV1SwapFromDecoded, type EnvioRawLaunchRow, type EnvioRawSwapRow } from './transformV1Legacy.js';
import { readAllRawLaunches, readAllRawSwaps } from './envioDb.js';

const legacy = getPonsFactorySources()[0];

export interface EnvioTableNames {
  rawLaunchTable: string;
  rawSwapTable: string;
}

// Real, confirmed-empirically (Task 1 Step 7 / Task 2 Step 7) production table names — the default
// unless a caller (e.g. a test standing in a throwaway schema for Envio's own Postgres) overrides them.
export const DEFAULT_ENVIO_TABLES: EnvioTableNames = {
  rawLaunchTable: 'envio."RawLaunch"',
  rawSwapTable: 'envio."RawSwap"',
};

function defaultRpcClient(): V1ReadClient {
  return createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
}

export async function syncV1LegacyOnce(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioTableNames = DEFAULT_ENVIO_TABLES,
  rpcClient: V1ReadClient = defaultRpcClient(),
): Promise<{ launchesWritten: number; tradesWritten: number }> {
  const existingRows = await appDb.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging);
  const existingTokens = new Set(existingRows.map((row) => row.tokenAddress.toLowerCase()));

  const rawLaunches = await readAllRawLaunches(envioPool, tables.rawLaunchTable);
  let launchesWritten = 0;
  const launchByPool = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchRow = {
      chainId: raw.chainId,
      tokenAddress: raw.tokenAddress,
      deployerAddress: raw.deployerAddress,
      pairTokenAddress: raw.pairTokenAddress,
      poolAddress: raw.poolAddress,
      blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash,
      txHash: raw.txHash,
      logIndex: raw.logIndex,
    };
    const event = envioRawLaunchToEvent(row);
    const isNew = !existingTokens.has(event.tokenAddress.toLowerCase());
    // Real RPC metadata only for a launch this sync has never written before — an already-synced
    // launch's name/symbol don't change, and this sync layer re-reads Envio's FULL raw table every
    // cycle (not an incremental feed), so without this check every launch would trigger a fresh RPC
    // round-trip every 15 minutes forever.
    const metadata = isNew
      ? await readV1TokenMetadata(rpcClient, event.tokenAddress)
      : { name: '', symbol: '', decimals: 18, liquidityPool: event.poolAddress };
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV1Launch(event, legacy, metadata, false));
    } catch (error) {
      throw new Error(`Failed to sync launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByPool.set(event.poolAddress, { launch, venue });
    if (isNew) {
      const inserted = await appDb.transaction(async (tx) => {
        const launchRows = await tx.insert(launchesEnvioStaging).values({
          chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name, symbol: launch.symbol,
          tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
          factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
          launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
          quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: null,
        }).onConflictDoNothing().returning({ tokenAddress: launchesEnvioStaging.tokenAddress });
        if (launchRows.length === 0) return false;
        await tx.insert(venuesEnvioStaging).values({
          id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
          effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
        }).onConflictDoNothing();
        return true;
      });
      if (inserted) launchesWritten += 1;
    }
  }

  const rawSwaps = await readAllRawSwaps(envioPool, tables.rawSwapTable);
  let tradesWritten = 0;
  for (const raw of rawSwaps) {
    const context = launchByPool.get(raw.poolAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawSwapRow = {
      poolAddress: raw.poolAddress, sender: raw.sender, recipient: raw.recipient,
      amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1), sqrtPriceX96: BigInt(raw.sqrtPriceX96),
      liquidity: BigInt(raw.liquidity), tick: raw.tick, blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash, txHash: raw.txHash, logIndex: raw.logIndex, timestamp: raw.timestamp,
    };
    let trade;
    try {
      trade = hydrateV1SwapFromDecoded(row, context.venue, context.launch, raw.txFrom as Address);
    } catch (error) {
      throw new Error(`Failed to sync swap at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    if (!trade) continue;
    const tradeRows = await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null, priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
      traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: tradesEnvioStaging.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }
  return { launchesWritten, tradesWritten };
}
```

(`eq` import is unused in this file as written — remove it; it is needed starting Task 6. Leave it out here, `npx eslint` will flag an unused import otherwise.)

- [ ] **Step 4: Typecheck and run the existing integration test (must still pass unchanged)**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSync.integration.test.ts src/envioSync/runSync.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean; integration test still green (it uses a mock RPC-shaped call only if it already seeds one — if it does not pass a 4th argument, confirm the default `defaultRpcClient()` is never hit because the test's fixture tokens are already present in `launchesEnvioStaging` from a prior insert in the same test run, OR update the integration test to pass an explicit mock `rpcClient` covering its one new-launch case; read the existing test file first and adjust minimally — do not let it make a real network call).

- [ ] **Step 5: Commit**

```bash
cd be && git add src/envioSync/runSync.ts src/envioSync/runSync.test.ts src/envioSync/runSync.integration.test.ts
cd .. && git commit -m "feat: enrich new V1-legacy launches with real on-chain name/symbol via RPC"
```

---

### Task 2: RPC metadata enrichment for V2 launches (token + quote asset)

**Files:**
- Modify: `be/src/envioSync/runSyncV2.ts`
- Modify: `be/src/envioSync/transformV2.ts` (extend `hydrateV2LaunchFromEnvio`'s signature)
- Test: `be/src/envioSync/transformV2.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `readV2TokenMetadata(client, token)`, `resolveV2QuoteAsset(pairToken, client)` from `be/src/launchpads/pons/v2/adapter.ts`.
- Produces: `hydrateV2LaunchFromEnvio(event, factory, metadata, quoteAsset)` — now takes real metadata/quoteAsset instead of hardcoding placeholders internally. `syncV2Once` gains an optional 4th parameter `rpcClient` (same type as Task 1's, V2's `V2QuoteClient`/`V2ReadClient` shapes are structurally compatible with `V1ReadClient` — all three are `{ readContract(...) }`).

- [ ] **Step 1: Write the failing test**

Read the existing `be/src/envioSync/transformV2.test.ts` first to match its existing fixture/import style, then add:

```typescript
// Appended to be/src/envioSync/transformV2.test.ts
describe('hydrateV2LaunchFromEnvio with real metadata', () => {
  it('uses the provided metadata and quote asset instead of placeholders', () => {
    const event = envioRawLaunchV2ToEvent({
      chainId: 4663, tokenAddress: '0x3333333333333333333333333333333333333333', curveAddress: '0x4444444444444444444444444444444444444444',
      deployerAddress: '0x5555555555555555555555555555555555555555', pairTokenAddress: '0x6666666666666666666666666666666666666666',
      blockNumber: 100n, blockHash: '0x' + 'a'.repeat(64), txHash: '0x' + 'b'.repeat(64), logIndex: 1,
    });
    const { launch } = hydrateV2LaunchFromEnvio(event, v2Factory, { name: 'Real Name', symbol: 'REAL', decimals: 18 },
      { address: event.pairToken, symbol: 'USDG', decimals: 6 });
    expect(launch.name).toBe('Real Name');
    expect(launch.symbol).toBe('REAL');
    expect(launch.quoteAsset).toEqual({ address: event.pairToken, symbol: 'USDG', decimals: 6 });
  });
});
```

(Add `v2Factory` to the test file's imports/setup if not already present — it is `getPonsFactorySources()[2]`, matching `runSyncV2.ts`'s own top-level constant; check the existing test file for whatever name it already uses for this and reuse it rather than introducing a second name.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd be && npx vitest run src/envioSync/transformV2.test.ts`
Expected: FAIL — `hydrateV2LaunchFromEnvio` does not accept a 3rd/4th argument yet (TS error or the extra args are silently ignored and `launch.name` is still `''`).

- [ ] **Step 3: Change `hydrateV2LaunchFromEnvio`'s signature in `transformV2.ts`**

```typescript
// Replace the existing hydrateV2LaunchFromEnvio in be/src/envioSync/transformV2.ts
export function hydrateV2LaunchFromEnvio(
  event: V2LaunchEvent,
  factory: FactorySource,
  metadata: { name: string; symbol: string; decimals: number },
  quoteAsset: { address: Address; symbol: string; decimals: number },
): V2LaunchWithVenue {
  const record: V2LaunchRecord = {
    token: event.tokenAddress, curve: event.curveAddress, deployer: event.deployerAddress,
    pairToken: event.pairToken, poolFee: 0, tickSpacing: 60, phase: 0, exists: true,
  };
  return hydrateV2Launch(event, factory, record, metadata, quoteAsset);
}
```

Update the doc comment above it to drop the now-inaccurate "placeholders" description (it previously explained why name/symbol/quoteAsset were hardcoded; that reasoning no longer applies since the caller now supplies real values) — replace with: `// metadata/quoteAsset now come from the caller (runSyncV2.ts), sourced via RPC for a new launch or carried over from the already-synced row for an existing one — see runSyncV2.ts. record is still synthesized from the event's own fields (poolFee/tickSpacing are real-pipeline-only, unused here), so hydrateV2Launch's record-matches-event check stays a structural no-op.`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd be && npx vitest run src/envioSync/transformV2.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `runSyncV2.ts`'s call site with the same new-vs-existing RPC skip pattern as Task 1**

In `be/src/envioSync/runSyncV2.ts`, add imports:

```typescript
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { readV2TokenMetadata, resolveV2QuoteAsset, type V2ReadClient } from '../launchpads/pons/v2/adapter.js';
```

Add before `export async function syncV2Once`:

```typescript
function defaultRpcClient(): V2ReadClient {
  return createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
}
```

Change the signature to `export async function syncV2Once(envioPool: Pool, appDb: Database, tables: EnvioV2TableNames = DEFAULT_ENVIO_V2_TABLES, rpcClient: V2ReadClient = defaultRpcClient())`.

Replace the launch loop body (everything from `const rawLaunches = ...` through the end of the `for (const raw of rawLaunches)` loop) with:

```typescript
  const rawLaunches = (await envioPool.query(`SELECT * FROM ${tables.rawLaunchV2Table} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLaunchV2Row[];
  const existingRows = await appDb.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging);
  const existingTokens = new Set(existingRows.map((row) => row.tokenAddress.toLowerCase()));
  let launchesWritten = 0;
  const launchByCurve = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const event = envioRawLaunchV2ToEvent(row);
    const isNew = !existingTokens.has(event.tokenAddress.toLowerCase());
    const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
    const metadata = isNew ? await readV2TokenMetadata(rpcClient, event.tokenAddress) : { name: '', symbol: '', decimals: 18 };
    // resolveKnownQuoteAsset only resolves the free case (native ETH); anything else needs the same
    // RPC skip-when-already-synced treatment as the launched token itself.
    const quoteAsset = knownQuoteAsset
      ? { address: event.pairToken, ...knownQuoteAsset }
      : isNew
        ? await resolveV2QuoteAsset(event.pairToken, rpcClient)
        : { address: event.pairToken, symbol: '', decimals: 18 };
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory, metadata, quoteAsset));
    } catch (error) {
      throw new Error(`Failed to sync V2 launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByCurve.set(event.curveAddress, { launch, venue });
    if (isNew) {
      const inserted = await appDb.transaction(async (tx) => {
        const launchRows = await tx.insert(launchesEnvioStaging).values({
          chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name, symbol: launch.symbol,
          tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
          factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
          launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address,
          quoteAssetSymbol: launch.quoteAsset.symbol, quoteAssetDecimals: launch.quoteAsset.decimals,
          lifecycleStatus: null,
        }).onConflictDoNothing().returning({ tokenAddress: launchesEnvioStaging.tokenAddress });
        if (launchRows.length === 0) return false;
        await tx.insert(venuesEnvioStaging).values({
          id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
          effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
        }).onConflictDoNothing();
        return true;
      });
      if (inserted) launchesWritten += 1;
    }
  }
```

Note: `launch.quoteAsset.symbol`/`quoteAssetDecimals` are now the REAL enriched values when `isNew` and resolvable (was previously always `knownQuoteAsset?.symbol ?? null`) — this is the intended fix from spec mục 2.

- [ ] **Step 6: Typecheck, run unit + integration tests**

Run: `cd be && npx tsc --noEmit && npx vitest run src/envioSync/transformV2.test.ts && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV2.integration.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean; both green. If the integration test calls `syncV2Once` without a 4th argument and its fixture token is not already present in staging, it will attempt a real RPC call and likely fail/hang — read the test first and pass an explicit mock `rpcClient` for its new-launch case, same adjustment as Task 1 Step 4.

- [ ] **Step 7: Commit**

```bash
cd be && git add src/envioSync/runSyncV2.ts src/envioSync/transformV2.ts src/envioSync/transformV2.test.ts src/envioSync/runSyncV2.integration.test.ts
cd .. && git commit -m "feat: enrich new V2 launches with real on-chain token and quote-asset metadata via RPC"
```

---

### Task 3: Schema migration — nullable sourceLogId, lifecycle_transitions PK, launches.launchLogIndex

**Files:**
- Modify: `be/src/db/schema.ts`
- Create: `be/drizzle/0016_*.sql` (generated by `drizzle-kit`, exact filename assigned by the tool)
- Test: `be/src/db/schema.migration.test.ts` (create)

**Interfaces:**
- Produces: `launches.launchLogIndex: integer NOT NULL`; `launches.sourceLogId`, `venues.sourceLogId`, `trades.sourceLogId` nullable; `lifecycleTransitions` primary key is `(chainId, txHash, logIndex)`, `sourceLogId` a nullable plain column.

- [ ] **Step 1: Write the failing integration test**

```typescript
// be/src/db/schema.migration.test.ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { launches, lifecycleTransitions } from './schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

describe('0016 migration — nullable sourceLogId, launchLogIndex, lifecycle_transitions PK', () => {
  it('accepts a launches row with sourceLogId null and launchLogIndex set', async () => {
    const token = '0x7777777777777777777777777777777777777777';
    await db.delete(launches).where(eq(launches.tokenAddress, token));
    await db.insert(launches).values({
      chainId: 4663, tokenAddress: token, sourceId: 'pons-v1-legacy', sourceLogId: null, launchLogIndex: 5,
      name: 'X', symbol: 'X', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v1',
      factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4', deployerAddress: '0x8888888888888888888888888888888888888888',
      launchBlock: 1n, launchTxHash: '0x' + 'c'.repeat(64), quoteAssetAddress: '0x0000000000000000000000000000000000000000',
      quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
    });
    const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(row.sourceLogId).toBeNull();
    expect(row.launchLogIndex).toBe(5);
    await db.delete(launches).where(eq(launches.tokenAddress, token));
  });

  it('accepts a lifecycle_transitions row with sourceLogId null, keyed by (chainId, txHash, logIndex)', async () => {
    const txHash = '0x' + 'd'.repeat(64);
    await db.delete(lifecycleTransitions).where(eq(lifecycleTransitions.txHash, txHash));
    await db.insert(lifecycleTransitions).values({
      chainId: 4663, tokenAddress: '0x9999999999999999999999999999999999999999', sourceId: 'pons-v2-lifecycle',
      sourceLogId: null, phase: 2, kind: 'graduated', blockNumber: 1n, blockHash: '0x' + 'e'.repeat(64),
      txHash, logIndex: 7,
    });
    const [row] = await db.select().from(lifecycleTransitions).where(eq(lifecycleTransitions.txHash, txHash));
    expect(row.sourceLogId).toBeNull();
    await db.delete(lifecycleTransitions).where(eq(lifecycleTransitions.txHash, txHash));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/db/schema.migration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `sourceLogId` NOT NULL violation (`launches.launchLogIndex` also doesn't exist yet, a separate TS error until Step 3's schema.ts change).

- [ ] **Step 3: Edit `be/src/db/schema.ts`**

In the `launches` table definition (`be/src/db/schema.ts:60-83`), change:
```typescript
  sourceLogId: text('source_log_id').notNull().references(() => rawLogs.id, { onDelete: 'cascade' }),
```
to:
```typescript
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'cascade' }),
```
and add a new field after `launchTxHash: text('launch_tx_hash').notNull(),`:
```typescript
  // The log index of the TokenLaunched event itself — stored directly so listLaunches (be/src/api/
  // store.ts) can sort/paginate without an INNER JOIN to raw_logs, which silently drops any row whose
  // sourceLogId is null (every Envio-sourced launch, once sourceLogId above is nullable). Backfilled
  // for pre-existing rows from raw_logs in this same migration (see the generated SQL, Step 4).
  launchLogIndex: integer('launch_log_index').notNull(),
```

In `venues` (`be/src/db/schema.ts:85-101`), change the same `sourceLogId` line the same way (drop `.notNull()`).

In `trades` (`be/src/db/schema.ts:131-157`), change the same `sourceLogId` line the same way.

In `lifecycleTransitions` (`be/src/db/schema.ts:103-117`), change:
```typescript
export const lifecycleTransitions = pgTable('lifecycle_transitions', {
  sourceLogId: text('source_log_id').primaryKey().references(() => rawLogs.id, { onDelete: 'cascade' }),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  phase: integer('phase').notNull(),
  kind: text('kind').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
}, (table) => [
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('lifecycle_transitions_token_position_idx').on(table.chainId, table.tokenAddress, table.blockNumber, table.logIndex),
]);
```
to:
```typescript
export const lifecycleTransitions = pgTable('lifecycle_transitions', {
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'cascade' }),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  phase: integer('phase').notNull(),
  kind: text('kind').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('lifecycle_transitions_token_position_idx').on(table.chainId, table.tokenAddress, table.blockNumber, table.logIndex),
]);
```

- [ ] **Step 4: Generate the migration, then hand-edit it to add the `launchLogIndex` backfill**

```bash
cd be && npx drizzle-kit generate
```

Expected: a new file `drizzle/0016_<generated_name>.sql`. Open it and confirm it contains (in some order): dropping the `launches_source_log_id_...` / `trades_...` / `venues_...` NOT NULL constraints (or `ALTER COLUMN ... DROP NOT NULL`), adding `launches.launch_log_index integer NOT NULL` (drizzle-kit will likely refuse to add a NOT NULL column with no default against a non-empty table, or add it nullable first — if it generates `ADD COLUMN "launch_log_index" integer NOT NULL` directly without a backfill, Postgres will reject this against the live table's existing rows; if it generates it nullable, that's fine, the hand-edit below handles making it NOT NULL after backfill), the `lifecycle_transitions` primary key change (drop old constraint on `source_log_id`, add new composite one on `(chain_id, tx_hash, log_index)`).

Hand-edit the generated file: ensure the `launches.launch_log_index` column is added as **nullable first** (if drizzle-kit didn't already do this), insert a backfill statement immediately after it and before any `NOT NULL` is applied, and apply `SET NOT NULL` last. The file should read, in this relative order (adapt exact statement syntax to whatever drizzle-kit actually emitted for the other changes — do not hand-write those, only insert the three lines below around the `launch_log_index` column):

```sql
ALTER TABLE "launches" ADD COLUMN "launch_log_index" integer;--> statement-breakpoint
UPDATE "launches" SET "launch_log_index" = r.log_index FROM "raw_logs" r WHERE r.id = "launches"."source_log_id";--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "launch_log_index" SET NOT NULL;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd be && npm run db:migrate -- --help > /dev/null; TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run db:migrate && npx vitest run src/db/schema.migration.test.ts --config vitest.integration.config.ts`
Expected: migration applies cleanly against `launchpad_test` (which already has real launches rows from other integration tests' fixtures with real `source_log_id` values, giving the backfill statement real rows to exercise); test passes 2/2.

- [ ] **Step 6: Typecheck and run the full existing test suites (schema change touches shared types)**

Run: `cd be && npx tsc --noEmit && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`
Expected: clean typecheck; both suites fully green — `tsc` will surface every insert call site across the codebase (API, old indexer, other sync modules) that builds a `launches`/`lifecycleTransitions` row and is now missing the new required `launchLogIndex` field or needs updating for the PK change; fix each one found (the old indexer's own `be/src/db/repository.ts` insert-launch path needs `launchLogIndex` added from the log it already has in hand — read that call site and the `RawLog`/event shape it already carries before editing, the log index is already available there, this is a one-line addition, not new data).

- [ ] **Step 7: Commit**

```bash
cd be && git add src/db/schema.ts drizzle/0016_*.sql src/db/schema.migration.test.ts
# plus any other files Step 6 required fixing — git status to confirm the full set
cd .. && git commit -m "feat: migrate schema for Envio cutover — nullable sourceLogId, launches.launchLogIndex, lifecycle_transitions PK"
```

---

### Task 4: Fix `listLaunches` to stop depending on `raw_logs`

**Files:**
- Modify: `be/src/api/store.ts`
- Create: `be/src/api/store.integration.test.ts` (no existing DB-backed test harness for `store.ts` — `server.test.ts` only exercises the HTTP routing layer against a mocked `data` object, confirmed by reading it during planning; this is a new file, following the same direct-schema-insert pattern as `be/src/envioSync/*.integration.test.ts`)

**Interfaces:**
- Consumes: `launches.launchLogIndex` from Task 3.
- Produces: no change to `listLaunches`'s external response shape or pagination cursor encoding — only its internal query changes.

- [ ] **Step 1: Write the failing test**

```typescript
// be/src/api/store.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { launches, sources } from '../db/schema.js';
import { createApiStore } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const store = createApiStore(pool);

const nullSourceLogIdToken = '0x1313131313131313131313131313131313131313';
const realSourceLogIdToken = '0x1414141414141414141414141414141414141414';

beforeAll(async () => {
  await db.delete(launches).where(eq(launches.tokenAddress, nullSourceLogIdToken));
  await db.delete(launches).where(eq(launches.tokenAddress, realSourceLogIdToken));
  await db.insert(sources).values({
    id: 'pons-v1-legacy', chainId: 4663, version: 'v1', factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4',
    startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'caught_up',
  }).onConflictDoNothing();
  // Same block, different launchLogIndex — null-sourceLogId launch has the HIGHER log index, so it
  // must sort FIRST (DESC order) ahead of the real-sourceLogId one for this test to actually pin the
  // ordering, not just presence.
  await db.insert(launches).values([
    { chainId: 4663, tokenAddress: nullSourceLogIdToken, sourceId: 'pons-v1-legacy', sourceLogId: null, launchLogIndex: 5,
      name: 'NullLog', symbol: 'NL', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v1',
      factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4', deployerAddress: '0x1515151515151515151515151515151515151515',
      launchBlock: 500n, launchTxHash: '0x' + 'b'.repeat(64), quoteAssetAddress: '0x0000000000000000000000000000000000000000',
      quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading' },
    { chainId: 4663, tokenAddress: realSourceLogIdToken, sourceId: 'pons-v1-legacy', sourceLogId: null, launchLogIndex: 2,
      name: 'RealLog', symbol: 'RL', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v1',
      factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4', deployerAddress: '0x1616161616161616161616161616161616161616',
      launchBlock: 500n, launchTxHash: '0x' + 'c'.repeat(64), quoteAssetAddress: '0x0000000000000000000000000000000000000000',
      quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading' },
  ]);
});

afterAll(async () => {
  await db.delete(launches).where(eq(launches.tokenAddress, nullSourceLogIdToken));
  await db.delete(launches).where(eq(launches.tokenAddress, realSourceLogIdToken));
  await pool.end();
});

describe('listLaunches', () => {
  it('includes a launch with sourceLogId null, correctly ordered by launchLogIndex', async () => {
    const result = await store.listLaunches({ limit: 50, chainId: 4663 });
    const tokens = result.items.map((item) => item.tokenAddress);
    expect(tokens).toContain(nullSourceLogIdToken);
    expect(tokens).toContain(realSourceLogIdToken);
    expect(tokens.indexOf(nullSourceLogIdToken)).toBeLessThan(tokens.indexOf(realSourceLogIdToken));
  });
});
```

(`realSourceLogIdToken`'s own `sourceLogId` is also `null` here — naming reflects its role as "the lower-logIndex counterpart," not that it carries a real `raw_logs` row; a true pre-existing-real-row case, with an actual `raw_logs` seed, is unnecessary for pinning this specific ordering bug and would add `raw_logs`/`sources` FK setup noise without strengthening the assertion — presence-with-null-sourceLogId is exactly the bug this task fixes.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — the null-`sourceLogId` launch is missing from `result.items` (INNER JOIN drops it).

- [ ] **Step 3: Edit `listLaunches`'s query in `be/src/api/store.ts`**

Change:
```typescript
      const result = await pool.query(`
        SELECT l.*, s.status AS source_status, r.block_number, r.tx_hash, r.log_index,
          (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
           WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
             AND t.timestamp >= $6) AS official_volume_raw,
          ${launchCoverageSql(9)} AS launch_coverage_complete
        FROM launches l JOIN sources s ON s.id = l.source_id JOIN raw_logs r ON r.id = l.source_log_id
        WHERE ($1::integer IS NULL OR l.chain_id = $1)
          AND ($2::bigint IS NULL OR (r.block_number, r.tx_hash, r.log_index) < ($2::bigint, $3::text, $4::integer))
          AND ($7::text IS NULL OR l.name ILIKE '%' || $7 || '%' OR l.symbol ILIKE '%' || $7 || '%')
          AND ($8::text IS NULL OR l.lifecycle_status = $8)
        ORDER BY r.block_number DESC, r.tx_hash DESC, r.log_index DESC LIMIT $5`,
```
to:
```typescript
      const result = await pool.query(`
        SELECT l.*, s.status AS source_status, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
          (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
           WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
             AND t.timestamp >= $6) AS official_volume_raw,
          ${launchCoverageSql(9)} AS launch_coverage_complete
        FROM launches l JOIN sources s ON s.id = l.source_id
        WHERE ($1::integer IS NULL OR l.chain_id = $1)
          AND ($2::bigint IS NULL OR (l.launch_block, l.launch_tx_hash, l.launch_log_index) < ($2::bigint, $3::text, $4::integer))
          AND ($7::text IS NULL OR l.name ILIKE '%' || $7 || '%' OR l.symbol ILIKE '%' || $7 || '%')
          AND ($8::text IS NULL OR l.lifecycle_status = $8)
        ORDER BY l.launch_block DESC, l.launch_tx_hash DESC, l.launch_log_index DESC LIMIT $5`,
```

(`l.*` already includes `launch_log_index`/`launch_block`/`launch_tx_hash` since those are real columns on `launches` now — the explicit `AS block_number`/`AS tx_hash`/`AS log_index` aliases keep `page()`'s existing `row.block_number`/`row.tx_hash`/`row.log_index` reads in `page()` (`be/src/api/store.ts`'s `page` function, used for cursor encoding) working unchanged, no changes needed there.)

- [ ] **Step 4: Run it to verify it passes, plus the full existing API test suite**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/ --config vitest.integration.config.ts`
Expected: new test passes; every pre-existing `listLaunches`/pagination test in `be/src/api/` still passes unchanged (confirms the Review Focus item: pagination order/boundaries unchanged for pre-existing real rows).

- [ ] **Step 5: Commit**

```bash
cd be && git add src/api/store.ts src/api/store.integration.test.ts
cd .. && git commit -m "fix: stop listLaunches from silently dropping launches with no raw_logs row"
```

---

### Task 5: Shared reorg-safety mechanism for the sync layer

**Files:**
- Create: `be/src/envioSync/reorgGuard.ts`
- Test: `be/src/envioSync/reorgGuard.integration.test.ts`

**Interfaces:**
- Produces: `reconcileReorgWindow(appDb: Database, tables: ReorgTargetTables, windowStart: bigint): Promise<void>` — deletes rows from each of the 4 target tables independently, filtered by that table's own block column, for `block_number/launch_block/effective_from_block >= windowStart`. Called by Task 6's real-table sync functions (and may be retrofitted onto the staging-writing ones too; this task only builds and tests the function itself).

- [ ] **Step 1: Write the failing integration test — the Review Focus cascade case**

```typescript
// be/src/envioSync/reorgGuard.integration.test.ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { launches, venues, trades } from '../db/schema.js';
import { reconcileReorgWindow, type ReorgTargetTables } from './reorgGuard.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

const oldToken = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const oldTxOutsideWindow = '0x' + '1'.repeat(64);
const oldTxInsideWindow = '0x' + '2'.repeat(64);

beforeAll(async () => {
  await db.delete(trades).where(eq(trades.tokenAddress, oldToken));
  await db.delete(venues).where(eq(venues.tokenAddress, oldToken));
  await db.delete(launches).where(eq(launches.tokenAddress, oldToken));
  await db.insert(launches).values({
    chainId: 4663, tokenAddress: oldToken, sourceId: 'pons-v1-legacy', sourceLogId: null, launchLogIndex: 0,
    name: 'Old', symbol: 'OLD', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v1',
    factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4', deployerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    launchBlock: 100n, launchTxHash: '0x' + '3'.repeat(64), quoteAssetAddress: '0x0000000000000000000000000000000000000000',
    quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
  });
  await db.insert(venues).values({
    id: `4663:v3_pool:${oldToken}-pool`, chainId: 4663, tokenAddress: oldToken, kind: 'v3_pool', ref: `${oldToken}-pool`,
    sourceId: 'pons-v1-legacy-trades', sourceLogId: null, effectiveFromBlock: 100n, official: true,
  });
  // One trade WAY outside the reorg window (old, confirmed history) and one trade INSIDE it (recent).
  await db.insert(trades).values([
    { chainId: 4663, tokenAddress: oldToken, venueId: `4663:v3_pool:${oldToken}-pool`, blockNumber: 100n,
      blockHash: '0x' + '4'.repeat(64), txHash: oldTxOutsideWindow, logIndex: 0, timestamp: 1_700_000_000,
      side: 'buy', tokenAmountRaw: '1', quoteAmountRaw: '1', quoteAssetAddress: '0x0000000000000000000000000000000000000000',
      sourceEvent: 'Swap', activityKind: 'user_trade', sourceLogId: null, traderAddress: oldToken },
    { chainId: 4663, tokenAddress: oldToken, venueId: `4663:v3_pool:${oldToken}-pool`, blockNumber: 999_900n,
      blockHash: '0x' + '5'.repeat(64), txHash: oldTxInsideWindow, logIndex: 0, timestamp: 1_700_000_001,
      side: 'buy', tokenAmountRaw: '1', quoteAmountRaw: '1', quoteAssetAddress: '0x0000000000000000000000000000000000000000',
      sourceEvent: 'Swap', activityKind: 'user_trade', sourceLogId: null, traderAddress: oldToken },
  ]);
});

afterAll(async () => {
  await db.delete(trades).where(eq(trades.tokenAddress, oldToken));
  await db.delete(venues).where(eq(venues.tokenAddress, oldToken));
  await db.delete(launches).where(eq(launches.tokenAddress, oldToken));
  await pool.end();
});

describe('reconcileReorgWindow', () => {
  it('deletes only the in-window trade, keeps the old launch and its out-of-window trade intact', async () => {
    const tables: ReorgTargetTables = { launches, venues, trades };
    await reconcileReorgWindow(db, tables, 999_500n);

    const remainingTrades = await db.select().from(trades).where(eq(trades.tokenAddress, oldToken));
    expect(remainingTrades.map((t) => t.txHash)).toEqual([oldTxOutsideWindow]);

    const remainingLaunches = await db.select().from(launches).where(eq(launches.tokenAddress, oldToken));
    expect(remainingLaunches).toHaveLength(1);
    const remainingVenues = await db.select().from(venues).where(eq(venues.tokenAddress, oldToken));
    expect(remainingVenues).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/reorgGuard.integration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `reorgGuard.js` module not found.

- [ ] **Step 3: Write `be/src/envioSync/reorgGuard.ts`**

```typescript
import { gte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { launches, venues, trades, lifecycleTransitions, launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';

// Any one of the two concrete table-set shapes (real tables, or staging tables) this function can
// target — `launches`/`launchesEnvioStaging` both expose a column it filters by below.
export interface ReorgTargetTables {
  launches: typeof launches | typeof launchesEnvioStaging;
  venues: typeof venues | typeof venuesEnvioStaging;
  trades: typeof trades | typeof tradesEnvioStaging;
  lifecycleTransitions?: typeof lifecycleTransitions | typeof lifecycleTransitionsEnvioStaging;
}

// Deletes rows in the given reorg window INDEPENDENTLY per table, filtered by each table's own block
// column — deliberately NOT by deleting `launches` and relying on its ON DELETE CASCADE to venues/
// trades, which would also destroy OUT-OF-WINDOW rows for any token launched before the window (see
// the spec's mục 4 note). Only a launches row whose OWN launchBlock falls inside the window is
// deleted directly; for that row cascading away its (necessarily also in-window, since nothing
// predates its own launch) venues/trades is correct, not accidental over-deletion.
export async function reconcileReorgWindow(appDb: Database, tables: ReorgTargetTables, windowStart: bigint): Promise<void> {
  await appDb.delete(tables.trades).where(gte(tables.trades.blockNumber, windowStart));
  if (tables.lifecycleTransitions) {
    await appDb.delete(tables.lifecycleTransitions).where(gte(tables.lifecycleTransitions.blockNumber, windowStart));
  }
  await appDb.delete(tables.venues).where(gte(tables.venues.effectiveFromBlock, windowStart));
  await appDb.delete(tables.launches).where(gte(tables.launches.launchBlock, windowStart));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/reorgGuard.integration.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean; PASS 1/1.

- [ ] **Step 5: Add a second test covering the staging-table target (Review Focus: must work for both targets)**

```typescript
// appended to reorgGuard.integration.test.ts
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';

it('also works against the staging table set', async () => {
  const stagingToken = '0xcccccccccccccccccccccccccccccccccccccccc';
  await db.delete(tradesEnvioStaging).where(eq(tradesEnvioStaging.tokenAddress, stagingToken));
  await db.delete(venuesEnvioStaging).where(eq(venuesEnvioStaging.tokenAddress, stagingToken));
  await db.delete(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, stagingToken));
  await db.insert(launchesEnvioStaging).values({
    chainId: 4663, tokenAddress: stagingToken, name: 'S', symbol: 'S', tokenDecimals: 18,
    platform: 'pons', protocolVersion: 'v1', factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4',
    deployerAddress: '0xdddddddddddddddddddddddddddddddddddddddd', launchBlock: 999_900n,
    launchTxHash: '0x' + '6'.repeat(64), quoteAssetAddress: '0x0000000000000000000000000000000000000000',
    quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
  });
  const tables: ReorgTargetTables = { launches: launchesEnvioStaging, venues: venuesEnvioStaging, trades: tradesEnvioStaging };
  await reconcileReorgWindow(db, tables, 999_500n);
  const remaining = await db.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, stagingToken));
  expect(remaining).toHaveLength(0);
});
```

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/reorgGuard.integration.test.ts --config vitest.integration.config.ts`
Expected: PASS 2/2.

- [ ] **Step 6: Write the failing test for `currentMaxBlock` — the "how far has this real-table sync gotten" query Tasks 6-8 need**

```typescript
// appended to reorgGuard.integration.test.ts
import { currentMaxBlock } from './reorgGuard.js';

describe('currentMaxBlock', () => {
  it('returns the highest trade block for venues matching the given sourceId prefix, or null if none', async () => {
    const token = '0xffffffffffffffffffffffffffffffffffffffff';
    await db.delete(trades).where(eq(trades.tokenAddress, token));
    await db.delete(venues).where(eq(venues.tokenAddress, token));
    await db.delete(launches).where(eq(launches.tokenAddress, token));
    await db.insert(launches).values({
      chainId: 4663, tokenAddress: token, sourceId: 'pons-v1-legacy', sourceLogId: null, launchLogIndex: 0,
      name: 'M', symbol: 'M', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v1',
      factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4', deployerAddress: '0x1212121212121212121212121212121212121212',
      launchBlock: 10n, launchTxHash: '0x' + '7'.repeat(64), quoteAssetAddress: '0x0000000000000000000000000000000000000000',
      quoteAssetSymbol: 'ETH', quoteAssetDecimals: 18, lifecycleStatus: 'trading',
    });
    await db.insert(venues).values({
      id: `4663:v3_pool:${token}-pool`, chainId: 4663, tokenAddress: token, kind: 'v3_pool', ref: `${token}-pool`,
      sourceId: 'pons-v1-legacy-trades', sourceLogId: null, effectiveFromBlock: 10n, official: true,
    });
    await db.insert(trades).values([
      { chainId: 4663, tokenAddress: token, venueId: `4663:v3_pool:${token}-pool`, blockNumber: 50n,
        blockHash: '0x' + '8'.repeat(64), txHash: '0x' + '9'.repeat(64), logIndex: 0, timestamp: 1,
        side: 'buy', tokenAmountRaw: '1', quoteAmountRaw: '1', quoteAssetAddress: '0x0000000000000000000000000000000000000000',
        sourceEvent: 'Swap', activityKind: 'user_trade', sourceLogId: null, traderAddress: token },
      { chainId: 4663, tokenAddress: token, venueId: `4663:v3_pool:${token}-pool`, blockNumber: 80n,
        blockHash: '0x' + 'a'.repeat(64), txHash: '0x' + 'f'.repeat(64), logIndex: 0, timestamp: 2,
        side: 'buy', tokenAmountRaw: '1', quoteAmountRaw: '1', quoteAssetAddress: '0x0000000000000000000000000000000000000000',
        sourceEvent: 'Swap', activityKind: 'user_trade', sourceLogId: null, traderAddress: token },
    ]);
    const max = await currentMaxBlock(db, 'pons-v1-legacy%');
    expect(max).toBe(80n);
    const none = await currentMaxBlock(db, 'no-such-source-prefix%');
    expect(none).toBeNull();
    await db.delete(trades).where(eq(trades.tokenAddress, token));
    await db.delete(venues).where(eq(venues.tokenAddress, token));
    await db.delete(launches).where(eq(launches.tokenAddress, token));
  });
});
```

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/reorgGuard.integration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `currentMaxBlock` not exported.

- [ ] **Step 7: Add `currentMaxBlock` to `reorgGuard.ts`**

```typescript
// appended to be/src/envioSync/reorgGuard.ts — add these imports to the existing import line:
// import { gte, eq, like, desc } from 'drizzle-orm';
import { venues as realVenues, trades as realTrades } from '../db/schema.js';

// Real-table-only (venuesEnvioStaging has no sourceId column to filter by — staging sync functions
// don't need this, they always reconcile from block 0 since staging has no "progress so far" concept
// worth tracking). Used by syncV1LegacyToReal/syncV2ToReal/syncV4ToReal (Tasks 6-8) to find the
// highest block their own previously-written trades reached, scoping both the reorg window and the
// sources.confirmedToBlock update to their own source's actual progress.
export async function currentMaxBlock(appDb: Database, venueSourceIdPattern: string): Promise<bigint | null> {
  const rows = await appDb.select({ blockNumber: realTrades.blockNumber }).from(realTrades)
    .innerJoin(realVenues, eq(realTrades.venueId, realVenues.id))
    .where(like(realVenues.sourceId, venueSourceIdPattern))
    .orderBy(desc(realTrades.blockNumber)).limit(1);
  return rows[0] ? rows[0].blockNumber : null;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/reorgGuard.integration.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean; PASS 3/3.

- [ ] **Step 9: Commit**

```bash
cd be && git add src/envioSync/reorgGuard.ts src/envioSync/reorgGuard.integration.test.ts
cd .. && git commit -m "feat: add shared reorg-safety reconciliation and progress lookup for the Envio sync layer"
```

---

### Task 6: Write path to the real tables — V1-legacy

**Files:**
- Modify: `be/src/envioSync/runSync.ts`
- Test: `be/src/envioSync/runSync.integration.test.ts`

**Interfaces:**
- Consumes: `reconcileReorgWindow` (Task 5).
- Produces: `syncV1LegacyToReal(envioPool, appDb, tables, rpcClient, reorgWindowBlocks = 500): Promise<{ launchesWritten: number; tradesWritten: number }>` — writes into `launches`/`venues`/`trades` instead of the staging equivalents, with `sourceLogId: null`, `launchLogIndex` set, `sourceId: legacy.id` (already `'pons-v1-legacy'`), updates `sources.confirmedToBlock`/`status` for `'pons-v1-legacy'` and `'pons-v1-legacy-trades'`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// Appended to be/src/envioSync/runSync.integration.test.ts — read the existing file's fixture setup
// first (staging-target test) and follow its exact synthetic-address/cleanup discipline, using a
// SECOND, distinct synthetic token (never reuse the staging test's token — see Phase 3's cross-file
// collision lesson, docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase3.md Task 5).
import { launches, venues, trades, sources } from '../db/schema.js';
import { syncV1LegacyToReal } from './runSync.js';

describe('syncV1LegacyToReal', () => {
  it('writes a new launch and trade into the real tables with real metadata and no sourceLogId', async () => {
    const realToken = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // ... seed envio_fixture."RawLaunch"/"RawSwap" rows for realToken, same pattern as the existing
    // staging test in this file, with a mock rpcClient returning { name: 'Real', symbol: 'RL',
    // decimals: 18, liquidityPool: <matching pool address> } for 'name'/'symbol'/'decimals'/
    // 'liquidityPool' ...
    const result = await syncV1LegacyToReal(envioPool, db, fixtureTables, mockRpcClient);
    expect(result).toEqual({ launchesWritten: 1, tradesWritten: 1 });
    const [launchRow] = await db.select().from(launches).where(eq(launches.tokenAddress, realToken));
    expect(launchRow.name).toBe('Real');
    expect(launchRow.sourceLogId).toBeNull();
    expect(launchRow.sourceId).toBe('pons-v1-legacy');
    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, 'pons-v1-legacy'));
    expect(sourceRow.confirmedToBlock >= launchRow.launchBlock).toBe(true);
    // cleanup realToken rows from launches/venues/trades in afterAll, matching existing pattern
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSync.integration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `syncV1LegacyToReal` is not exported.

- [ ] **Step 3: Add `syncV1LegacyToReal` to `runSync.ts`**

Add imports: `import { eq } from 'drizzle-orm';`, `import { launches, venues, trades, sources } from '../db/schema.js';`, `import { reconcileReorgWindow, currentMaxBlock } from './reorgGuard.js';`.

```typescript
export async function syncV1LegacyToReal(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioTableNames = DEFAULT_ENVIO_TABLES,
  rpcClient: V1ReadClient = defaultRpcClient(),
  reorgWindowBlocks = 500n,
): Promise<{ launchesWritten: number; tradesWritten: number }> {
  const priorMaxBlock = await currentMaxBlock(appDb, `${legacy.id}-trades%`);
  const windowStart = priorMaxBlock !== null && priorMaxBlock > reorgWindowBlocks ? priorMaxBlock - reorgWindowBlocks : 0n;
  await reconcileReorgWindow(appDb, { launches, venues, trades }, windowStart);

  const existingRows = await appDb.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, legacy.id));
  const existingTokens = new Set(existingRows.map((row) => row.tokenAddress.toLowerCase()));
  const rawLaunches = await readAllRawLaunches(envioPool, tables.rawLaunchTable);
  let launchesWritten = 0;
  let highestBlock = 0n;
  const launchByPool = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchRow = {
      chainId: raw.chainId, tokenAddress: raw.tokenAddress, deployerAddress: raw.deployerAddress,
      pairTokenAddress: raw.pairTokenAddress, poolAddress: raw.poolAddress, blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash, txHash: raw.txHash, logIndex: raw.logIndex,
    };
    const event = envioRawLaunchToEvent(row);
    const isNew = !existingTokens.has(event.tokenAddress.toLowerCase());
    const metadata = isNew ? await readV1TokenMetadata(rpcClient, event.tokenAddress) : { name: '', symbol: '', decimals: 18, liquidityPool: event.poolAddress };
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV1Launch(event, legacy, metadata, false));
    } catch (error) {
      throw new Error(`Failed to sync launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByPool.set(event.poolAddress, { launch, venue });
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    if (isNew) {
      const inserted = await appDb.transaction(async (tx) => {
        const launchRows = await tx.insert(launches).values({
          chainId: launch.chainId, tokenAddress: launch.tokenAddress, sourceId: launch.sourceId, sourceLogId: null,
          launchLogIndex: raw.logIndex, name: launch.name, symbol: launch.symbol, tokenDecimals: launch.tokenDecimals,
          platform: launch.platform, protocolVersion: launch.protocolVersion, factoryAddress: launch.factoryAddress,
          deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock, launchTxHash: launch.launchTxHash,
          quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
          quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
        }).onConflictDoNothing().returning({ tokenAddress: launches.tokenAddress });
        if (launchRows.length === 0) return false;
        await tx.insert(venues).values({
          id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
          sourceId: `${legacy.id}-trades`, sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
        }).onConflictDoNothing();
        return true;
      });
      if (inserted) launchesWritten += 1;
    }
  }

  const rawSwaps = await readAllRawSwaps(envioPool, tables.rawSwapTable);
  let tradesWritten = 0;
  for (const raw of rawSwaps) {
    const context = launchByPool.get(raw.poolAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawSwapRow = {
      poolAddress: raw.poolAddress, sender: raw.sender, recipient: raw.recipient, amount0: BigInt(raw.amount0),
      amount1: BigInt(raw.amount1), sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity),
      tick: raw.tick, blockNumber: BigInt(raw.blockNumber), blockHash: raw.blockHash, txHash: raw.txHash,
      logIndex: raw.logIndex, timestamp: raw.timestamp,
    };
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    let trade;
    try {
      trade = hydrateV1SwapFromDecoded(row, context.venue, context.launch, raw.txFrom as Address);
    } catch (error) {
      throw new Error(`Failed to sync swap at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    if (!trade) continue;
    const tradeRows = await appDb.insert(trades).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
      priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null, priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
      traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: trades.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  if (highestBlock > 0n) {
    await appDb.update(sources).set({ confirmedToBlock: highestBlock, scannedToBlock: highestBlock, status: 'caught_up' }).where(eq(sources.id, legacy.id));
    await appDb.update(sources).set({ confirmedToBlock: highestBlock, scannedToBlock: highestBlock, status: 'caught_up' }).where(eq(sources.id, `${legacy.id}-trades`));
  }
  return { launchesWritten, tradesWritten };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSync.integration.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean (after fixing the flagged `windowStart` query); PASS.

- [ ] **Step 5: Add the Review Focus regression test — pre-existing real launch is not duplicated or errored on**

```typescript
it('does not error or duplicate when the real launches row already exists (written by the old indexer)', async () => {
  // Seed a `launches` row for a token directly (simulating the old indexer having already written
  // it), with a REAL sourceLogId this time (requires seeding a matching raw_logs row too — read
  // be/src/db/schema.ts's rawLogs table and an existing old-indexer test fixture for the exact shape).
  // Then seed the SAME token as an Envio raw launch and run syncV1LegacyToReal.
  const result = await syncV1LegacyToReal(envioPool, db, fixtureTables, mockRpcClient);
  expect(result.launchesWritten).toBe(0); // already existed, skipped — not an error, not a duplicate
  const rows = await db.select().from(launches).where(eq(launches.tokenAddress, preExistingToken));
  expect(rows).toHaveLength(1);
  expect(rows[0].sourceLogId).not.toBeNull(); // untouched — still has its original real sourceLogId
});
```

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSync.integration.test.ts --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd be && git add src/envioSync/runSync.ts src/envioSync/runSync.integration.test.ts
cd .. && git commit -m "feat: add syncV1LegacyToReal — write V1-legacy data into the real tables"
```

---

### Task 7: Write path to the real tables — V2 (launch, curve, lifecycle)

**Files:**
- Modify: `be/src/envioSync/runSyncV2.ts`
- Test: `be/src/envioSync/runSyncV2.integration.test.ts`

**Interfaces:**
- Consumes: `reconcileReorgWindow` (Task 5).
- Produces: `syncV2ToReal(envioPool, appDb, tables, rpcClient, reorgWindowBlocks = 500n)` — same shape as Task 6 but for V2, writing `lifecycleTransitions` too, `sourceId: 'pons-v2'` for launches, `'pons-v2-curve'` for curve venues, updating `sources` rows for `'pons-v2'`, `'pons-v2-curve'`, `'pons-v2-lifecycle'` (all three already exist from the old indexer — confirm this assumption against a real `launchpad` DB snapshot or the old indexer's own `sourceRegistry.ts`/registration call sites before writing the update logic, per the spec mục 3 correction).

- [ ] **Step 1: Write the failing integration test**

Follow the exact same structure as Task 6 Step 1, adapted to V2's fixtures (reuse this file's existing staging-test fixture style, a THIRD distinct synthetic token/curve address not colliding with any other test file in this module — see Task 6 Step 1's collision note).

```typescript
import { launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';
import { syncV2ToReal } from './runSyncV2.js';

describe('syncV2ToReal', () => {
  it('writes a new V2 launch, curve trade, and graduated lifecycle transition into the real tables', async () => {
    // ... seed envio raw launch/curve-trade/lifecycle rows for a fresh synthetic token, mock rpcClient ...
    const result = await syncV2ToReal(envioPool, db, fixtureTables, mockRpcClient);
    expect(result).toEqual({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 });
    const [launchRow] = await db.select().from(launches).where(eq(launches.tokenAddress, v2RealToken));
    expect(launchRow.sourceId).toBe('pons-v2');
    const [venueRow] = await db.select().from(venues).where(eq(venues.tokenAddress, v2RealToken));
    expect(venueRow.sourceId).toBe('pons-v2-curve');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV2.integration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `syncV2ToReal` not exported.

- [ ] **Step 3: Add `syncV2ToReal` to `runSyncV2.ts`**

Add imports: `import { eq } from 'drizzle-orm';`, `import { launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';`, `import { reconcileReorgWindow, currentMaxBlock } from './reorgGuard.js';`, `import { createRobinhoodPublicClient } from '../chains/robinhood.js';`, `import { readV2TokenMetadata, resolveV2QuoteAsset, type V2ReadClient } from '../launchpads/pons/v2/adapter.js';` (the last two are already added in Task 2 Step 5 if that task touched this file first — do not duplicate the import).

```typescript
export async function syncV2ToReal(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV2TableNames = DEFAULT_ENVIO_V2_TABLES,
  rpcClient: V2ReadClient = defaultRpcClient(),
  reorgWindowBlocks = 500n,
): Promise<{ launchesWritten: number; tradesWritten: number; transitionsWritten: number }> {
  const priorMaxBlock = await currentMaxBlock(appDb, 'pons-v2-curve%');
  const windowStart = priorMaxBlock !== null && priorMaxBlock > reorgWindowBlocks ? priorMaxBlock - reorgWindowBlocks : 0n;
  await reconcileReorgWindow(appDb, { launches, venues, trades, lifecycleTransitions }, windowStart);

  const rawLaunches = (await envioPool.query(`SELECT * FROM ${tables.rawLaunchV2Table} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLaunchV2Row[];
  const existingRows = await appDb.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, v2Factory.id));
  const existingTokens = new Set(existingRows.map((row) => row.tokenAddress.toLowerCase()));
  let launchesWritten = 0;
  let highestBlock = 0n;
  const launchByCurve = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const event = envioRawLaunchV2ToEvent(row);
    const isNew = !existingTokens.has(event.tokenAddress.toLowerCase());
    const knownQuoteAsset = resolveKnownQuoteAsset(event.pairToken);
    const metadata = isNew ? await readV2TokenMetadata(rpcClient, event.tokenAddress) : { name: '', symbol: '', decimals: 18 };
    const quoteAsset = knownQuoteAsset
      ? { address: event.pairToken, ...knownQuoteAsset }
      : isNew ? await resolveV2QuoteAsset(event.pairToken, rpcClient) : { address: event.pairToken, symbol: '', decimals: 18 };
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory, metadata, quoteAsset));
    } catch (error) {
      throw new Error(`Failed to sync V2 launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByCurve.set(event.curveAddress, { launch, venue });
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    if (isNew) {
      const inserted = await appDb.transaction(async (tx) => {
        const launchRows = await tx.insert(launches).values({
          chainId: launch.chainId, tokenAddress: launch.tokenAddress, sourceId: launch.sourceId, sourceLogId: null,
          launchLogIndex: raw.logIndex, name: launch.name, symbol: launch.symbol, tokenDecimals: launch.tokenDecimals,
          platform: launch.platform, protocolVersion: launch.protocolVersion, factoryAddress: launch.factoryAddress,
          deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock, launchTxHash: launch.launchTxHash,
          quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
          quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
        }).onConflictDoNothing().returning({ tokenAddress: launches.tokenAddress });
        if (launchRows.length === 0) return false;
        await tx.insert(venues).values({
          id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
          sourceId: 'pons-v2-curve', sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
        }).onConflictDoNothing();
        return true;
      });
      if (inserted) launchesWritten += 1;
    }
  }

  let tradesWritten = 0;
  const rawTrades = (await envioPool.query(`SELECT * FROM ${tables.rawCurveTradeTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveTradeRow[];
  for (const raw of rawTrades) {
    const context = launchByCurve.get(raw.curveAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawCurveTradeRow = { ...raw, tokenAmountRaw: BigInt(raw.tokenAmountRaw), quoteAmountRaw: BigInt(raw.quoteAmountRaw),
      feeRaw: BigInt(raw.feeRaw), taxRaw: BigInt(raw.taxRaw), blockNumber: BigInt(raw.blockNumber) };
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    const trade = hydrateCurveTradeFromDecoded(row, context.venue, context.launch);
    const tradeRows = await appDb.insert(trades).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: trades.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  const rawBuybacks = (await envioPool.query(`SELECT * FROM ${tables.rawCurveBuybackTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveBuybackRow[];
  for (const raw of rawBuybacks) {
    const context = launchByCurve.get(raw.curveAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawCurveBuybackRow = { ...raw, quoteSpentRaw: BigInt(raw.quoteSpentRaw), tokensLockedRaw: BigInt(raw.tokensLockedRaw), blockNumber: BigInt(raw.blockNumber) };
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    const trade = hydrateCurveBuybackFromDecoded(row, context.venue, context.launch);
    const tradeRows = await appDb.insert(trades).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: trades.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  let transitionsWritten = 0;
  const rawTransitions = (await envioPool.query(`SELECT * FROM ${tables.rawLifecycleTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLifecycleRow[];
  for (const raw of rawTransitions) {
    const row: EnvioRawLifecycleRow = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    const rows = await appDb.insert(lifecycleTransitions).values({
      sourceLogId: null, chainId: transition.chainId, tokenAddress: transition.tokenAddress, sourceId: 'pons-v2-lifecycle',
      phase: transition.phase, kind: transition.kind, blockNumber: transition.blockNumber,
      blockHash: transition.blockHash, txHash: transition.txHash, logIndex: transition.logIndex,
    }).onConflictDoNothing().returning({ txHash: lifecycleTransitions.txHash });
    if (rows.length > 0) transitionsWritten += 1;
  }

  if (highestBlock > 0n) {
    for (const sourceId of ['pons-v2', 'pons-v2-curve', 'pons-v2-lifecycle']) {
      await appDb.update(sources).set({ confirmedToBlock: highestBlock, scannedToBlock: highestBlock, status: 'caught_up' }).where(eq(sources.id, sourceId));
    }
  }
  return { launchesWritten, tradesWritten, transitionsWritten };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV2.integration.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 5: Commit**

```bash
cd be && git add src/envioSync/runSyncV2.ts src/envioSync/runSyncV2.integration.test.ts
cd .. && git commit -m "feat: add syncV2ToReal — write V2 launch/curve/lifecycle data into the real tables"
```

---

### Task 8: Write path to the real tables — V4, with the per-pool source id fix

**Files:**
- Modify: `be/src/envioSync/runSyncV4.ts`
- Modify: `be/src/envioSync/transformV4.ts` (fix the static `sourceId: 'pons-v2-v4'` — Review Focus item)
- Test: `be/src/envioSync/runSyncV4.integration.test.ts`, `be/src/envioSync/transformV4.test.ts`

**Interfaces:**
- Consumes: `reconcileReorgWindow` (Task 5).
- Produces: `syncV4ToReal(envioPool, appDb, tables, reorgWindowBlocks = 500n)` (no RPC client needed — V4 has no metadata gap, confirmed in spec mục 1). `openV4Venue`'s caller now passes the correct per-pool source id when targeting the real table.

- [ ] **Step 1: Write the failing test for the source-id fix (transformV4.test.ts)**

```typescript
// appended to be/src/envioSync/transformV4.test.ts
it('assigns the per-pool source id, not a static one, when opening a venue for the real table', () => {
  const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch)!;
  const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: 27828161n, logIndex: 36 });
  expect(venue.sourceId).toBe(`pons-v2-v4:${evidence.poolId.toLowerCase()}`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && npx vitest run src/envioSync/transformV4.test.ts`
Expected: FAIL — current `openV4Venue`/`transitionOfficialVenue` sets `sourceId: 'pons-v2-v4'` (static), not the per-pool form.

- [ ] **Step 3: Fix `transformV4.ts`**

In `verifyV4PoolFromEnvio`'s return (`be/src/envioSync/transformV4.ts`), change:
```typescript
  return { poolId: row.poolId.toLowerCase() as Hash, sourceLogId: `v4-init-${row.txHash.toLowerCase()}-${row.logIndex}`, sourceId: 'pons-v2-v4' };
```
to:
```typescript
  return { poolId: row.poolId.toLowerCase() as Hash, sourceLogId: `v4-init-${row.txHash.toLowerCase()}-${row.logIndex}`, sourceId: `pons-v2-v4:${row.poolId.toLowerCase()}` };
```

Check this does not break the EXISTING staging-writing path (`transformV4.ts`'s `sourceId` is only read by `runSyncV4.ts`'s `openV4Venue` call and stored into `venuesEnvioStaging` — which has no `sourceId` column at all, confirmed earlier in this session, so staging silently ignores this value regardless of its shape; this change is purely preparing the value for Task 8 Step 4's real-table write, with no staging-side behavior change).

- [ ] **Step 4: Run it to verify it passes, and the existing transformV4 suite stays green**

Run: `cd be && npx vitest run src/envioSync/transformV4.test.ts`
Expected: PASS, all tests in the file green (10 existing + 1 new = 11).

- [ ] **Step 5: Write the failing integration test for `syncV4ToReal`**

Follow Task 6/7's pattern with a fourth distinct synthetic token/pool-id. Confirm:
```typescript
const [venueRow] = await db.select().from(venues).where(eq(venues.kind, 'v4_pool'));
expect(venueRow.sourceId).toBe(`pons-v2-v4:${testPoolId}`);
const [sourceRow] = await db.select().from(sources).where(eq(sources.id, `pons-v2-v4:${testPoolId}`));
expect(sourceRow).toBeDefined(); // newly registered — this is the one case Task 3/plan's "no new sources rows needed" exception
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV4.integration.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `syncV4ToReal` not exported.

- [ ] **Step 7: Add `syncV4ToReal` to `runSyncV4.ts`**

Mirror `syncV4Once`'s structure (read earlier in this session — two loops: open verified venues for pending graduations, then sync swaps for all open v4_pool venues), with these differences:
- Writes to `venues`/`trades` instead of `venuesEnvioStaging`/`tradesEnvioStaging`.
- `venues` insert: `sourceId: venue.sourceId` (now the correct per-pool form from Task 8 Step 3), `sourceLogId: null`.
- `trades` insert: `sourceLogId: null`.
Add imports: `import { and, eq, notExists } from 'drizzle-orm';`, `import { launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';`, `import { reconcileReorgWindow, currentMaxBlock } from './reorgGuard.js';`.

```typescript
// Same audited PoolManager address as be/src/indexer/lifecycleRuntime.ts's expectedPoolManager —
// needed here only to satisfy sources.factoryAddress NOT NULL when registering a new per-pool source
// row; V4 pool verification itself (verifyV4PoolFromEnvio) does not use this constant.
const v4PoolManager = '0x8366a39cC670b4001a1121b8f6A443A643E40951';

function toRealLaunch(row: typeof launches.$inferSelect): Launch {
  return {
    chainId: row.chainId, tokenAddress: row.tokenAddress as `0x${string}`, name: row.name, symbol: row.symbol,
    tokenDecimals: row.tokenDecimals, platform: 'pons', protocolVersion: 'v2', sourceId: row.sourceId, sourceLogId: '',
    factoryAddress: row.factoryAddress as `0x${string}`, deployerAddress: row.deployerAddress as `0x${string}`,
    launchBlock: row.launchBlock, launchTxHash: row.launchTxHash as `0x${string}`,
    quoteAsset: { address: row.quoteAssetAddress as `0x${string}`, symbol: row.quoteAssetSymbol, decimals: row.quoteAssetDecimals },
    lifecycleStatus: 'graduated',
  };
}

export async function syncV4ToReal(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV4TableNames = DEFAULT_ENVIO_V4_TABLES,
  reorgWindowBlocks = 500n,
): Promise<{ venuesOpened: number; tradesWritten: number }> {
  const priorMaxBlock = await currentMaxBlock(appDb, 'pons-v2-v4:%');
  const windowStart = priorMaxBlock !== null && priorMaxBlock > reorgWindowBlocks ? priorMaxBlock - reorgWindowBlocks : 0n;
  await reconcileReorgWindow(appDb, { launches, venues, trades, lifecycleTransitions }, windowStart);

  const pendingGraduations = await appDb
    .select({
      tokenAddress: lifecycleTransitions.tokenAddress, txHash: lifecycleTransitions.txHash,
      blockHash: lifecycleTransitions.blockHash, blockNumber: lifecycleTransitions.blockNumber, logIndex: lifecycleTransitions.logIndex,
    })
    .from(lifecycleTransitions)
    .where(and(
      eq(lifecycleTransitions.kind, 'graduated'),
      notExists(appDb.select().from(venues).where(and(
        eq(venues.tokenAddress, lifecycleTransitions.tokenAddress), eq(venues.kind, 'v4_pool'),
      ))),
    ));

  let venuesOpened = 0;
  if (pendingGraduations.length > 0) {
    const graduationTxHashes = [...new Set(pendingGraduations.map((g) => g.txHash.toLowerCase()))];
    const rawInitializes = (await envioPool.query(
      `SELECT * FROM ${tables.rawV4InitializeTable} WHERE LOWER("txHash") = ANY($1) ORDER BY "blockNumber", "logIndex"`,
      [graduationTxHashes],
    )).rows as EnvioRawV4InitializeRow[];

    for (const graduation of pendingGraduations) {
      const launchRow = (await appDb.select().from(launches).where(eq(launches.tokenAddress, graduation.tokenAddress)))[0];
      const curveVenueRow = (await appDb.select().from(venues).where(and(eq(venues.tokenAddress, graduation.tokenAddress), eq(venues.kind, 'curve'))))[0];
      if (!launchRow || !curveVenueRow) continue;
      const launch = toRealLaunch(launchRow);
      const curveVenue: Venue = {
        id: curveVenueRow.id, chainId: curveVenueRow.chainId, tokenAddress: curveVenueRow.tokenAddress as `0x${string}`,
        kind: 'curve', ref: curveVenueRow.ref, sourceId: curveVenueRow.sourceId, sourceLogId: '',
        effectiveFromBlock: curveVenueRow.effectiveFromBlock, effectiveToBlock: null, official: curveVenueRow.official,
      };
      let evidence = null;
      for (const candidate of rawInitializes) {
        if (candidate.txHash.toLowerCase() !== graduation.txHash.toLowerCase()) continue;
        const row: EnvioRawV4InitializeRow = { ...candidate, blockNumber: BigInt(candidate.blockNumber) };
        evidence = verifyV4PoolFromEnvio(row, graduation.txHash, graduation.blockHash, launch);
        if (evidence) break;
      }
      if (!evidence) continue;
      const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: graduation.blockNumber, logIndex: graduation.logIndex });
      await appDb.insert(sources).values({
        id: venue.sourceId, chainId: venue.chainId, version: 'v4', factoryAddress: v4PoolManager,
        startBlock: venue.effectiveFromBlock, scannedToBlock: venue.effectiveFromBlock,
        confirmedToBlock: venue.effectiveFromBlock, status: 'backfilling',
      }).onConflictDoNothing();
      const venueRows = await appDb.insert(venues).values({
        id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
        sourceId: venue.sourceId, sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
      }).onConflictDoNothing().returning({ id: venues.id });
      if (venueRows.length > 0) venuesOpened += 1;
    }
  }

  let tradesWritten = 0;
  const v4Venues = await appDb.select().from(venues).where(eq(venues.kind, 'v4_pool'));
  if (v4Venues.length > 0) {
    const poolIds = [...new Set(v4Venues.map((v) => v.ref.toLowerCase()))];
    const rawSwaps = (await envioPool.query(
      `SELECT * FROM ${tables.rawV4SwapTable} WHERE LOWER("poolId") = ANY($1) ORDER BY "blockNumber", "logIndex"`,
      [poolIds],
    )).rows as EnvioRawV4SwapRow[];
    const venueByPoolId = new Map(v4Venues.map((v) => [v.ref.toLowerCase(), v]));
    const launchCache = new Map<string, Launch>();
    const poolHighestBlock = new Map<string, bigint>();
    for (const raw of rawSwaps) {
      const venueRow = venueByPoolId.get(raw.poolId.toLowerCase());
      if (!venueRow) continue;
      const tokenKey = venueRow.tokenAddress.toLowerCase();
      let launch = launchCache.get(tokenKey);
      if (!launch) {
        const launchRow = (await appDb.select().from(launches).where(eq(launches.tokenAddress, venueRow.tokenAddress)))[0];
        if (!launchRow) continue;
        launch = toRealLaunch(launchRow);
        launchCache.set(tokenKey, launch);
      }
      const venue: Venue = {
        id: venueRow.id, chainId: venueRow.chainId, tokenAddress: venueRow.tokenAddress as `0x${string}`,
        kind: 'v4_pool', ref: venueRow.ref, sourceId: venueRow.sourceId, sourceLogId: '',
        effectiveFromBlock: venueRow.effectiveFromBlock, effectiveToBlock: null, official: venueRow.official,
      };
      const row: EnvioRawV4SwapRow = { ...raw, amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1),
        sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity), blockNumber: BigInt(raw.blockNumber) };
      // launch.quoteAsset.decimals is a real, non-null value here (the real `launches` row always has
      // it, unlike the staging path's possibly-unknown case) — passed directly, not through a separate
      // nullable parameter the way syncV4Once's staging path needs to.
      const trade = hydrateV4SwapFromDecoded(row, venue, launch, launch.quoteAsset.decimals);
      if (!trade) continue;
      if (row.blockNumber > (poolHighestBlock.get(venue.sourceId) ?? 0n)) poolHighestBlock.set(venue.sourceId, row.blockNumber);
      const tradeRows = await appDb.insert(trades).values({
        chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
        blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
        tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
        quoteAssetAddress: trade.quoteAssetAddress, sourceEvent: trade.sourceEvent, sourceLogId: null,
        priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null, priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
        traderAddress: trade.traderAddress,
      }).onConflictDoNothing().returning({ txHash: trades.txHash });
      if (tradeRows.length > 0) tradesWritten += 1;
    }
    for (const [sourceId, highestBlock] of poolHighestBlock) {
      await appDb.update(sources).set({ confirmedToBlock: highestBlock, scannedToBlock: highestBlock, status: 'caught_up' }).where(eq(sources.id, sourceId));
    }
  }

  return { venuesOpened, tradesWritten };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd be && npx tsc --noEmit && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV4.integration.test.ts --config vitest.integration.config.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 9: Commit**

```bash
cd be && git add src/envioSync/runSyncV4.ts src/envioSync/transformV4.ts src/envioSync/runSyncV4.integration.test.ts src/envioSync/transformV4.test.ts
cd .. && git commit -m "feat: add syncV4ToReal and fix the per-pool V4 source id for real-table coverage"
```

---

### Task 9: CLI wiring — select staging or real as the sync target

**Files:**
- Modify: `be/src/envioSync/syncAll.ts`
- Modify: `be/src/cli/syncEnvioStaging.ts`, `be/src/cli/syncEnvioStagingLoop.ts`
- Modify: `be/.env.example`, `README.md`

**Interfaces:**
- Produces: `runAllSyncsOnce(envioPool, appDb, tables, target: 'staging' | 'real', rpcClient?)` — `target` selects between the `*Once`/`*ToReal` function pairs from Tasks 1/2/6/7/8. Reads `ENVIO_SYNC_TARGET` env var (`staging` default, `real` opts in) in both CLIs.

- [ ] **Step 1: Write the failing test**

```typescript
// be/src/envioSync/syncAll.test.ts (create)
import { describe, expect, it, vi } from 'vitest';

// Since runAllSyncsOnce's real behavior is already covered end-to-end by each *Once/*ToReal
// function's own integration tests, this test only pins the dispatch logic: given target: 'real',
// it must call the *ToReal variants, not the staging ones. Mock the module.
vi.mock('./runSync.js', () => ({ syncV1LegacyOnce: vi.fn(async () => ({ launchesWritten: 0, tradesWritten: 0 })), syncV1LegacyToReal: vi.fn(async () => ({ launchesWritten: 1, tradesWritten: 1 })) }));
vi.mock('./runSyncV2.js', () => ({ syncV2Once: vi.fn(async () => ({ launchesWritten: 0, tradesWritten: 0, transitionsWritten: 0 })), syncV2ToReal: vi.fn(async () => ({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 })) }));
vi.mock('./runSyncV4.js', () => ({ syncV4Once: vi.fn(async () => ({ venuesOpened: 0, tradesWritten: 0 })), syncV4ToReal: vi.fn(async () => ({ venuesOpened: 1, tradesWritten: 1 })) }));

import { runAllSyncsOnce } from './syncAll.js';
import { syncV1LegacyToReal } from './runSync.js';

describe('runAllSyncsOnce target dispatch', () => {
  it('calls the *ToReal variants when target is "real"', async () => {
    const result = await runAllSyncsOnce({} as never, {} as never, { v1: {} as never, v2: {} as never, v4: {} as never }, 'real');
    expect(syncV1LegacyToReal).toHaveBeenCalled();
    expect(result.v1Result).toEqual({ launchesWritten: 1, tradesWritten: 1 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd be && npx vitest run src/envioSync/syncAll.test.ts`
Expected: FAIL — `runAllSyncsOnce` does not accept a `target` parameter yet.

- [ ] **Step 3: Update `syncAll.ts`**

```typescript
import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { syncV1LegacyOnce, syncV1LegacyToReal, DEFAULT_ENVIO_TABLES, type EnvioTableNames } from './runSync.js';
import { syncV2Once, syncV2ToReal, DEFAULT_ENVIO_V2_TABLES, type EnvioV2TableNames } from './runSyncV2.js';
import { syncV4Once, syncV4ToReal, DEFAULT_ENVIO_V4_TABLES, type EnvioV4TableNames } from './runSyncV4.js';

export interface AllSyncTables {
  v1: EnvioTableNames;
  v2: EnvioV2TableNames;
  v4: EnvioV4TableNames;
}

export type SyncTarget = 'staging' | 'real';

export function resolveSyncTablesFromEnv(): AllSyncTables {
  // unchanged from the existing implementation — keep as-is
  return {
    v1: {
      rawLaunchTable: process.env.ENVIO_RAW_LAUNCH_TABLE ?? DEFAULT_ENVIO_TABLES.rawLaunchTable,
      rawSwapTable: process.env.ENVIO_RAW_SWAP_TABLE ?? DEFAULT_ENVIO_TABLES.rawSwapTable,
    },
    v2: {
      rawLaunchV2Table: process.env.ENVIO_RAW_LAUNCH_V2_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLaunchV2Table,
      rawCurveTradeTable: process.env.ENVIO_RAW_CURVE_TRADE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveTradeTable,
      rawCurveBuybackTable: process.env.ENVIO_RAW_CURVE_BUYBACK_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveBuybackTable,
      rawLifecycleTable: process.env.ENVIO_RAW_LIFECYCLE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLifecycleTable,
    },
    v4: {
      rawV4InitializeTable: process.env.ENVIO_RAW_V4_INITIALIZE_TABLE ?? DEFAULT_ENVIO_V4_TABLES.rawV4InitializeTable,
      rawV4SwapTable: process.env.ENVIO_RAW_V4_SWAP_TABLE ?? DEFAULT_ENVIO_V4_TABLES.rawV4SwapTable,
    },
  };
}

export async function runAllSyncsOnce(envioPool: Pool, appDb: Database, tables: AllSyncTables, target: SyncTarget = 'staging') {
  const v1Result = target === 'real' ? await syncV1LegacyToReal(envioPool, appDb, tables.v1) : await syncV1LegacyOnce(envioPool, appDb, tables.v1);
  const v2Result = target === 'real' ? await syncV2ToReal(envioPool, appDb, tables.v2) : await syncV2Once(envioPool, appDb, tables.v2);
  const v4Result = target === 'real' ? await syncV4ToReal(envioPool, appDb, tables.v4) : await syncV4Once(envioPool, appDb, tables.v4);
  return { v1Result, v2Result, v4Result };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd be && npx tsc --noEmit && npx vitest run src/envioSync/syncAll.test.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 5: Wire the two CLIs to read `ENVIO_SYNC_TARGET`**

In both `be/src/cli/syncEnvioStaging.ts` and `be/src/cli/syncEnvioStagingLoop.ts`, add after the existing env checks:
```typescript
const syncTarget = (process.env.ENVIO_SYNC_TARGET ?? 'staging') as 'staging' | 'real';
if (syncTarget !== 'staging' && syncTarget !== 'real') throw new Error('ENVIO_SYNC_TARGET must be "staging" or "real"');
```
and change every `runAllSyncsOnce(envioPool, db, tables)` call to `runAllSyncsOnce(envioPool, db, tables, syncTarget)`.

- [ ] **Step 6: Document the new env var**

Append to `be/.env.example`:
```
# "staging" (default) writes to *_envio_staging; "real" writes directly into launches/venues/trades/
# lifecycle_transitions — only set to "real" as part of the cutover procedure (see
# docs/superpowers/specs/2026-10-01-envio-cutover-design.md mục 6), never casually.
# ENVIO_SYNC_TARGET=staging
```

Add a short note to README.md's Envio section pointing at the cutover spec for what `ENVIO_SYNC_TARGET=real` means (one or two sentences, matching the existing section's tone — do not duplicate the spec's content).

- [ ] **Step 7: Full suite + commit**

Run: `cd be && npx tsc --noEmit && npm run lint && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`
Expected: all clean/green.

```bash
cd be && git add src/envioSync/syncAll.ts src/envioSync/syncAll.test.ts src/cli/syncEnvioStaging.ts src/cli/syncEnvioStagingLoop.ts .env.example
cd .. && git add README.md && git commit -m "feat: add ENVIO_SYNC_TARGET to select staging vs real-table writes"
```

---

### Task 10: Cutover execution (STOP — requires explicit user go-ahead before starting)

**Do not start this task automatically after Task 9.** Everything above is ordinary code with no live side effects. This task stops the live RPC-scan indexer process, runs a migration against the live `launchpad` database, and changes what the live sync loop writes to — side effects on serving infrastructure, exactly the category CLAUDE.md requires a fresh, explicit confirmation for. Present the spec's mục 5 readiness checklist (all code tasks above green, tested) and mục 6 procedure to the user and wait for their go-ahead before running any step below.

**Files:** none (operational steps only — no new code).

- [ ] **Step 1: Confirm readiness (spec mục 5)**

All of: Task 1-2's enrichment tested; Task 3's migration tested on `launchpad_test`; Task 5's reorg guard tested; Task 6-8's `*ToReal` functions tested on `launchpad_test`. Run the full suite one more time as a final gate: `cd be && npx tsc --noEmit && npm run lint && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`.

- [ ] **Step 2: Run the migration against the live `launchpad` database**

```bash
cd be && DATABASE_URL="postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad" npm run db:migrate
```

Expected: `Migrations applied` (matches the exact command already used earlier this session for migrations 0011-0015 against this same live DB).

- [ ] **Step 3: Stop the live RPC-scan indexer**

```bash
ps aux | grep runFactoryIndexer | grep -v grep
```

Identify the real PID (not the `npm exec` wrapper) and send `SIGTERM` (not `SIGKILL`) so its own in-process shutdown handling (confirmed present in `runFactoryIndexer.ts` earlier this session) completes any in-flight batch cleanly:

```bash
kill -TERM <pid>
```

Wait for the process to exit (`ps aux | grep runFactoryIndexer` shows nothing), confirming no partial batch was left mid-write.

- [ ] **Step 4: Stop the current staging-target sync loop, restart it targeting `real`**

```bash
# stop the currently-running syncEnvioStagingLoop (PID noted earlier this session)
kill -TERM <sync-loop-pid>
# restart with ENVIO_SYNC_TARGET=real
cd be && nohup env DATABASE_URL="postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad" \
  ENVIO_DATABASE_URL="postgres://postgres:testing@127.0.0.1:5433/envio-dev" \
  ENVIO_SYNC_TARGET=real \
  npx tsx src/cli/syncEnvioStagingLoop.ts > /tmp/sync-envio-real-loop.log 2>&1 & disown
```

- [ ] **Step 5: Verify one real cycle**

Check `/tmp/sync-envio-real-loop.log` for a clean first cycle (no errors), then spot-check the API: `curl http://127.0.0.1:3001/launches?limit=5` (or whatever the actual dev API port/route is — confirm against `be/.env.example`'s `API_PORT`) and confirm existing launches still appear, correctly ordered, with their real `name`/`symbol` intact.

**If Step 5 shows any error or regression:** `kill -TERM` the real-target sync loop immediately, restart `runFactoryIndexer.ts` (it resumes from its saved cursors, no data loss — confirmed in the spec), and report the failure before attempting cutover again. Do not leave both systems stopped at the same time.

**If Step 5 is clean:** cutover is complete. Report to the user: indexer stopped, sync loop now targets real tables, what to watch for over the next ~22h+ while Envio's own historical scan catches up (per spec mục 5's accepted residual risk — no reorg monitoring yet on the not-yet-rescanned historical range).
