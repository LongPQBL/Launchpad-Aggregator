# Pool TVL "vs 24h ago" change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show `▼/▲ %` next to TVL on the pool detail page, comparing current TVL with TVL 24h ago, using hourly TVL snapshots recorded by a new worker.

**Architecture:** A worker reads the on-chain reserves lens for every verified V4 pool each hour and inserts a row (raw amounts + USD value at capture time) into a new `pool_tvl_snapshots` table, then prunes rows older than the retention window. `readPoolStats` looks up the snapshot nearest `now − 24h` (±2h, same quote asset) and returns `tvlChange`. The frontend renders it with the existing `PercentChange` component.

**Tech Stack:** Node ≥24, TypeScript, PostgreSQL + Drizzle migrations, viem, Vitest (unit + `*.integration.test.ts`), Fastify schemas → OpenAPI → `openapi-typescript`, Next.js/React.

**Spec:** `docs/superpowers/specs/2026-10-08-pool-tvl-change-design.md`

## Global Constraints

- Work directly on `main`; do not create a worktree or branch.
- Null means unavailable, never 0: any missing/invalid input yields `tvlChange: null` (rendered "—"), never `0`.
- Migrations additive only (`CREATE TABLE` / `CREATE INDEX`); never touch existing tables.
- Frontend copy and code identifiers in English.
- V4 pools only. `readUsdPrice` currently hardcodes chain 4663; do not change that.
- Retention must be ≥ 26h (worker refuses to start otherwise); snapshot interval must be 60–14400s so a row always falls inside the ±2h read window.
- The working tree contains unrelated uncommitted user edits in `fe/` (and `CLAUDE.md`, `envio/config.yaml`). Commit **only explicit paths you created or changed**, never `git add -A`/`.`. For `fe/` files that already show user edits in `git diff`, do not commit them; list them in the final report instead. `be/` was clean when this plan was written.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Already done and uncommitted from the previous task (`volume24hChange`): `be/src/pools/stats.ts`, `be/src/pools/stats.test.ts`, `be/src/pools/stats.integration.test.ts`, `be/src/api/schemas.ts`, `be/src/api/pools.test.ts`, `be/openapi.json`, plus FE files. Task 1 commits the `be/` part together with its refactor.

## Review Focus

- Retention below 26h or interval outside 60–14400s → worker refuses to start (Task 4 `parseSnapshotConfig` tests).
- Invalid lens result (`hasCustomAccounting: true`, zero sqrt price) → no row written (Task 4 test).
- Snapshot whose quote asset differs from the current TVL's quote side → `tvlChange: null` (Task 3 test).
- First 24h / no snapshot within ±2h of the mark → `null` (Task 3 test).
- Previous TVL of 0 → `null`, not Infinity/NaN (Task 1 `percentChange`, Task 3 test).
- Capture outage must not stop pruning (Task 4 `runSnapshotCycle` test).

---

### Task 1: Generic `percentChange`, commit the volume change

**Files:**
- Modify: `be/src/pools/valuation.ts` (add `percentChange`)
- Modify: `be/src/pools/valuation.test.ts`
- Modify: `be/src/pools/stats.ts` (replace `volumeChangePercent`)
- Delete: `be/src/pools/stats.test.ts`

**Interfaces:**
- Produces: `percentChange(current: string, previous: string): string | null` exported from `be/src/pools/valuation.ts`.

- [ ] **Step 1: Write the failing test** — append to `be/src/pools/valuation.test.ts` (add `percentChange` to the existing import from `./valuation.js`):

```ts
describe('percentChange', () => {
  it('is the change from the previous value to the current one', () => {
    expect(Number(percentChange('323', '858'))).toBeCloseTo(-62.35, 1);
    expect(Number(percentChange('300', '100'))).toBeCloseTo(200);
  });
  it('is null, not 0%, when the previous value is zero or unusable', () => {
    expect(percentChange('10', '0')).toBeNull();
    expect(percentChange('10', '-5')).toBeNull();
    expect(percentChange('10', 'NaN')).toBeNull();
    expect(percentChange('abc', '5')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && npx vitest run src/pools/valuation.test.ts`
Expected: FAIL (`percentChange` is not exported).

- [ ] **Step 3: Implement** — append to `be/src/pools/valuation.ts`:

```ts
/** Percent change from `previous` to `current`; null when either is unusable or `previous` is not positive (undefined, not 0%). */
export function percentChange(current: string, previous: string): string | null {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  return String(((now - before) / before) * 100);
}
```

In `be/src/pools/stats.ts`: delete the `volumeChangePercent` function and its doc comment, add `percentChange` to the existing `./valuation.js` import, and change the call `volumeChangePercent(volume24hUsd, previousVolumeUsd)` to `percentChange(volume24hUsd, previousVolumeUsd)`. Delete `be/src/pools/stats.test.ts` (an untracked file from the previous task; its cases moved above — nothing to stage for it).

- [ ] **Step 4: Run to verify it passes**

Run: `cd be && npx tsc --noEmit && npx vitest run src/pools src/api/pools.test.ts`
Expected: no tsc errors; all pass.

- [ ] **Step 5: Commit (BE only, includes the earlier volume work)**

```bash
cd /Users/long/Development/Launchpad-Aggregator
git add be/src/pools/valuation.ts be/src/pools/valuation.test.ts be/src/pools/stats.ts be/src/pools/stats.integration.test.ts be/src/api/schemas.ts be/src/api/pools.test.ts be/openapi.json
git commit -m "feat: add pool 24h volume change vs previous 24h" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Extract the reserves-lens read into `lens.ts`

**Files:**
- Create: `be/src/pools/lens.ts`
- Modify: `be/src/pools/stats.ts` (`readPoolSnapshot` and the lens constants near the top)

**Interfaces:**
- Produces:
  - `interface LensPoolKey { currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }`
  - `interface LensSnapshot { blockNumber: bigint; coreAmount0: bigint; coreAmount1: bigint; sqrtPriceX96: bigint }`
  - `readLensSnapshot(client: UsdPriceClient | undefined, catalog: LensPoolKey): Promise<LensSnapshot | null>` — null on any failure or invalid result (same validation `readPoolSnapshot` has today).

Behavior-preserving refactor; the existing `stats.integration.test.ts` is the safety net (it exercises `getPoolTVL` through `readPoolStats`).

- [ ] **Step 1: Create `be/src/pools/lens.ts`**

```ts
import { parseAbi, type Address } from 'viem';
import type { UsdPriceClient } from '../market/usdPricing.js';

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
const RESERVES_LENS = '0x0000001b173C3bbF3984D417d8614E3eed34865B' as Address;
const lensAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct PoolTVL { uint256 coreAmount0; uint256 coreAmount1; uint256 hookReserves0; uint256 hookReserves1; uint256 hookEffective0; uint256 hookEffective1; uint160 sqrtPriceX96; int24 tick; uint128 activeLiquidity; uint256 blockNumber; address statsProvider; uint16 hookPermissions; bool hasCustomAccounting; uint8 statsStatus; }',
  'function getPoolTVL(address manager, PoolKey key) view returns (PoolTVL result)',
]);

export interface LensPoolKey { currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }
export interface LensSnapshot { blockNumber: bigint; coreAmount0: bigint; coreAmount1: bigint; sqrtPriceX96: bigint }

/** Current core reserves + spot price of a V4 pool from the reserves lens; null if unavailable or invalid. */
export async function readLensSnapshot(client: UsdPriceClient | undefined, catalog: LensPoolKey): Promise<LensSnapshot | null> {
  if (!client?.getBlockNumber) return null;
  try {
    const blockNumber = await client.getBlockNumber();
    const result = await client.readContract({ address: RESERVES_LENS, abi: lensAbi, functionName: 'getPoolTVL',
      args: [POOL_MANAGER, { currency0: catalog.currency0 as Address, currency1: catalog.currency1 as Address,
        fee: catalog.fee, tickSpacing: catalog.tick_spacing, hooks: catalog.hooks as Address }],
      blockNumber, gas: 30_000_000n });
    if (!result || typeof result !== 'object' || !('coreAmount0' in result) || !('coreAmount1' in result)
      || !('sqrtPriceX96' in result) || !('hasCustomAccounting' in result)
      || typeof result.coreAmount0 !== 'bigint' || typeof result.coreAmount1 !== 'bigint'
      || typeof result.sqrtPriceX96 !== 'bigint' || result.coreAmount0 < 0n || result.coreAmount1 < 0n
      || result.sqrtPriceX96 <= 0n || result.hasCustomAccounting !== false) return null;
    return { blockNumber, coreAmount0: result.coreAmount0, coreAmount1: result.coreAmount1, sqrtPriceX96: result.sqrtPriceX96 };
  } catch { return null; }
}
```

- [ ] **Step 2: Use it in `stats.ts`.** Delete the `POOL_MANAGER`, `RESERVES_LENS` and `lensAbi` constants (and `parseAbi`'s use for the lens; keep `parseAbi` for `erc20DecimalsAbi`). Add `import { readLensSnapshot } from './lens.js';`. Replace the whole `readPoolSnapshot` function with:

```ts
async function readPoolSnapshot(client: UsdPriceClient | undefined, catalog: PoolRow, displayedIsCurrency0: boolean,
  displayedDecimals: number | null, quoteDecimals: number | null, quoteUsd: number | null): Promise<{
    poolBalances: PoolBalanceSnapshot | null; tvlUsd: string | null;
  }> {
  if (displayedDecimals === null || quoteDecimals === null) return { poolBalances: null, tvlUsd: null };
  const lens = await readLensSnapshot(client, catalog);
  if (!lens) return { poolBalances: null, tvlUsd: null };
  try {
    const { blockNumber, coreAmount0, coreAmount1, sqrtPriceX96 } = lens;
    const priceInQuote = poolPriceInQuote(sqrtPriceX96, displayedDecimals, quoteDecimals, displayedIsCurrency0, 100);
    const poolBalances = priceInQuote === null ? null : {
      displayedAmountRaw: (displayedIsCurrency0 ? coreAmount0 : coreAmount1).toString(),
      otherAmountRaw: (displayedIsCurrency0 ? coreAmount1 : coreAmount0).toString(),
      priceInQuote,
    };
    const tvlUsd = quoteUsd === null ? null : calculateTvlUsd({
      tokenRaw: displayedIsCurrency0 ? coreAmount0 : coreAmount1,
      quoteRaw: displayedIsCurrency0 ? coreAmount1 : coreAmount0,
      blockNumber, basis: 'pool_principal', sqrtPriceX96,
      tokenIsCurrency0: displayedIsCurrency0,
    }, quoteDecimals, displayedDecimals, quoteUsd);
    return { poolBalances, tvlUsd };
  } catch { return { poolBalances: null, tvlUsd: null }; }
}
```

- [ ] **Step 3: Verify nothing changed**

Run: `cd be && npx tsc --noEmit && npx vitest run src/pools src/api && npx vitest run --config vitest.integration.config.ts src/pools/stats.integration.test.ts src/api/pools.integration.test.ts`
Expected: all pass (tvlUsd `'20'` and poolBalances assertions in `stats.integration.test.ts` unchanged).

- [ ] **Step 4: Commit**

```bash
cd /Users/long/Development/Launchpad-Aggregator
git add be/src/pools/lens.ts be/src/pools/stats.ts
git commit -m "refactor: extract V4 reserves lens read into lens.ts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Snapshot table, insert/prune/read-change

**Files:**
- Modify: `be/src/db/schema.ts` (add `poolTvlSnapshots` after `poolMembers`)
- Create: `be/drizzle/0047_*.sql` (generated) and update `be/drizzle/meta/*` (generated)
- Create: `be/src/pools/tvlSnapshots.ts`
- Test: `be/src/pools/tvlSnapshots.integration.test.ts`

**Interfaces:**
- Consumes: `percentChange` from `./valuation.js` (Task 1).
- Produces (all in `tvlSnapshots.ts`):
  - `interface TvlSnapshotInput { chainId: number; protocol: 'uniswap_v4'; poolId: string; blockNumber: bigint; capturedAtSeconds: number; coreAmount0Raw: bigint; coreAmount1Raw: bigint; sqrtPriceX96: bigint; quoteAddress: string; tvlUsd: string }`
  - `insertTvlSnapshot(pool: Pool, snapshot: TvlSnapshotInput): Promise<void>` (idempotent: `ON CONFLICT DO NOTHING`)
  - `pruneTvlSnapshots(pool: Pool, olderThanSeconds: number): Promise<number>` (deletes `captured_at < to_timestamp(olderThanSeconds)`, returns deleted count)
  - `readTvlChange(pool: Pool, key: { chainId: number; protocol: string; poolId: string }, quoteAddress: string, currentTvlUsd: string | null, asOf: number): Promise<string | null>`
  - constants `TVL_CHANGE_WINDOW_SECONDS = 86_400`, `TVL_CHANGE_TOLERANCE_SECONDS = 7_200`.

- [ ] **Step 1: Add the Drizzle table** to `be/src/db/schema.ts` (imports `numeric`, `bigint`, `check`, `index`, `primaryKey`, `sql`, `timestamp` already exist in that file):

```ts
export const poolTvlSnapshots = pgTable('pool_tvl_snapshots', {
  chainId: integer('chain_id').notNull(),
  protocol: text('protocol').notNull(),
  poolId: text('pool_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  coreAmount0Raw: numeric('core_amount0_raw', { precision: 78, scale: 0 }).notNull(),
  coreAmount1Raw: numeric('core_amount1_raw', { precision: 78, scale: 0 }).notNull(),
  sqrtPriceX96: numeric('sqrt_price_x96', { precision: 78, scale: 0 }).notNull(),
  quoteAddress: text('quote_address').notNull(),
  tvlUsd: numeric('tvl_usd', { precision: 78, scale: 30 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.protocol, table.poolId, table.blockNumber] }),
  check('pool_tvl_snapshots_protocol', sql`${table.protocol} = 'uniswap_v4'`),
  index('pool_tvl_snapshots_captured_at_idx').on(table.capturedAt),
]);
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd be && npm run db:generate`
Expected: a new `drizzle/0047_*.sql`. Open it: it must contain only `CREATE TABLE "pool_tvl_snapshots"` and `CREATE INDEX "pool_tvl_snapshots_captured_at_idx"` (plus the PK/check). If it contains anything else, stop and investigate.
Then apply to the test DB the way integration tests do (`vitest.integration.globalSetup.ts` runs migrations automatically; no manual step needed for tests). Do **not** run `db:migrate` against the live `launchpad` DB.

- [ ] **Step 3: Write the failing tests** — `be/src/pools/tvlSnapshots.integration.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { insertTvlSnapshot, pruneTvlSnapshots, readTvlChange } from './tvlSnapshots.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const poolId = `0x${'7'.repeat(64)}`;
const key = { chainId: 4663, protocol: 'uniswap_v4' as const, poolId };
const quote = '0x0000000000000000000000000000000000000000';
const asOf = 1_800_000_000;
const mark = asOf - 86_400;

async function snap(secondsFromMark: number, tvlUsd: string, quoteAddress = quote, block = 1000 + secondsFromMark) {
  await insertTvlSnapshot(pool, {
    chainId: 4663, protocol: 'uniswap_v4', poolId, blockNumber: BigInt(block), capturedAtSeconds: mark + secondsFromMark,
    coreAmount0Raw: 1n, coreAmount1Raw: 2n, sqrtPriceX96: 3n, quoteAddress, tvlUsd,
  });
}
afterEach(async () => { await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]); });
afterAll(async () => { await pool.end(); });

describe('readTvlChange', () => {
  it('uses the snapshot nearest to 24h ago and returns the percent change', async () => {
    await snap(-5000, '100');
    await snap(600, '200');
    expect(Number(await readTvlChange(pool, key, quote, '150', asOf))).toBeCloseTo(-25);
  });
  it('is null when no snapshot is within 2h of the 24h mark (e.g. the first 24h)', async () => {
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
    await snap(-8000, '100');
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
  });
  it('is null when the snapshot was priced through a different quote asset', async () => {
    await snap(0, '100', '0x1111111111111111111111111111111111111111');
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
  });
  it('is null when the previous TVL is zero or the current TVL is unavailable', async () => {
    await snap(0, '0');
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
    await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
    await snap(0, '100');
    expect(await readTvlChange(pool, key, quote, null, asOf)).toBeNull();
  });
});

describe('pruneTvlSnapshots', () => {
  it('deletes only rows older than the cutoff and reports how many', async () => {
    await snap(-200_000, '1');
    await snap(-100_000, '2');
    await snap(0, '3');
    const deleted = await pruneTvlSnapshots(pool, mark - 150_000);
    expect(deleted).toBe(1);
    const left = await pool.query('SELECT tvl_usd FROM pool_tvl_snapshots WHERE pool_id=$1 ORDER BY captured_at', [poolId]);
    expect(left.rows.map((row) => Number(row.tvl_usd))).toEqual([2, 3]);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd be && npx vitest run --config vitest.integration.config.ts src/pools/tvlSnapshots.integration.test.ts`
Expected: FAIL (module `./tvlSnapshots.js` not found).

- [ ] **Step 5: Implement** — `be/src/pools/tvlSnapshots.ts`:

```ts
import type { Pool } from 'pg';
import { percentChange } from './valuation.js';

export const TVL_CHANGE_WINDOW_SECONDS = 86_400;
export const TVL_CHANGE_TOLERANCE_SECONDS = 7_200;

export interface TvlSnapshotInput {
  chainId: number; protocol: 'uniswap_v4'; poolId: string; blockNumber: bigint; capturedAtSeconds: number;
  coreAmount0Raw: bigint; coreAmount1Raw: bigint; sqrtPriceX96: bigint; quoteAddress: string; tvlUsd: string;
}

export async function insertTvlSnapshot(pool: Pool, snapshot: TvlSnapshotInput): Promise<void> {
  await pool.query(`INSERT INTO pool_tvl_snapshots (chain_id, protocol, pool_id, block_number, captured_at,
      core_amount0_raw, core_amount1_raw, sqrt_price_x96, quote_address, tvl_usd)
    VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
  [snapshot.chainId, snapshot.protocol, snapshot.poolId.toLowerCase(), snapshot.blockNumber.toString(), snapshot.capturedAtSeconds,
    snapshot.coreAmount0Raw.toString(), snapshot.coreAmount1Raw.toString(), snapshot.sqrtPriceX96.toString(),
    snapshot.quoteAddress.toLowerCase(), snapshot.tvlUsd]);
}

/** Deletes snapshots captured before `olderThanSeconds` (unix seconds); returns the number deleted. */
export async function pruneTvlSnapshots(pool: Pool, olderThanSeconds: number): Promise<number> {
  const result = await pool.query('DELETE FROM pool_tvl_snapshots WHERE captured_at < to_timestamp($1)', [olderThanSeconds]);
  return result.rowCount ?? 0;
}

/**
 * Percent change of TVL vs the snapshot nearest to `asOf − 24h` (within ±2h). Null when there is no
 * such snapshot, it was priced through a different quote asset than the current TVL, or either
 * value is unusable — never 0.
 */
export async function readTvlChange(pool: Pool, key: { chainId: number; protocol: string; poolId: string },
  quoteAddress: string, currentTvlUsd: string | null, asOf: number): Promise<string | null> {
  if (currentTvlUsd === null) return null;
  const mark = asOf - TVL_CHANGE_WINDOW_SECONDS;
  const found = await pool.query(`SELECT tvl_usd, quote_address FROM pool_tvl_snapshots
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
      AND captured_at BETWEEN to_timestamp($4) AND to_timestamp($5)
    ORDER BY abs(extract(epoch FROM captured_at) - $6) ASC LIMIT 1`,
  [key.chainId, key.protocol, key.poolId.toLowerCase(), mark - TVL_CHANGE_TOLERANCE_SECONDS,
    mark + TVL_CHANGE_TOLERANCE_SECONDS, mark]);
  const row = found.rows[0] as { tvl_usd: string; quote_address: string } | undefined;
  if (!row || row.quote_address !== quoteAddress.toLowerCase()) return null;
  return percentChange(currentTvlUsd, row.tvl_usd);
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd be && npx tsc --noEmit && npx vitest run --config vitest.integration.config.ts src/pools/tvlSnapshots.integration.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/long/Development/Launchpad-Aggregator
git add be/src/db/schema.ts be/drizzle be/src/pools/tvlSnapshots.ts be/src/pools/tvlSnapshots.integration.test.ts
git commit -m "feat: add pool_tvl_snapshots table with insert, prune and 24h change lookup" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Capture logic, config validation, worker

**Files:**
- Create: `be/src/pools/tvlCapture.ts`
- Create: `be/src/cli/runPoolTvlSnapshotWorker.ts`
- Modify: `be/package.json` (add script)
- Test: `be/src/pools/tvlCapture.test.ts` (unit, config) and `be/src/pools/tvlCapture.integration.test.ts`

**Interfaces:**
- Consumes: `readLensSnapshot` (Task 2), `insertTvlSnapshot`/`pruneTvlSnapshots` (Task 3), `assetDecimals` (exported from `stats.ts`), `readUsdPrice`, `resolveVerifiedFeed`, `calculateTvlUsd`.
- Produces:
  - `MIN_RETENTION_HOURS = 26`
  - `interface SnapshotConfig { intervalSeconds: number; retentionHours: number }`
  - `parseSnapshotConfig(env: Record<string, string | undefined>): SnapshotConfig` (throws on invalid)
  - `captureTvlSnapshots(pool: Pool, client: UsdPriceClient, nowSeconds: number, log?: (message: string, error: unknown) => void): Promise<{ captured: number; skipped: number }>`
  - `runSnapshotCycle(pool: Pool, client: UsdPriceClient, config: SnapshotConfig, nowSeconds: number): Promise<{ captured: number; skipped: number; pruned: number }>` — prunes even if capture throws.

- [ ] **Step 1: Write the failing config test** — `be/src/pools/tvlCapture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSnapshotConfig } from './tvlCapture.js';

describe('parseSnapshotConfig', () => {
  it('defaults to hourly capture and 7 days of retention', () => {
    expect(parseSnapshotConfig({})).toEqual({ intervalSeconds: 3600, retentionHours: 168 });
  });
  it('refuses a retention shorter than 26h, which could delete the row the 24h comparison needs', () => {
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_RETENTION_HOURS: '25' })).toThrow(/>= 26/);
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_RETENTION_HOURS: 'abc' })).toThrow(/>= 26/);
    expect(parseSnapshotConfig({ POOL_TVL_SNAPSHOT_RETENTION_HOURS: '26' }).retentionHours).toBe(26);
  });
  it('refuses an interval outside 60-14400s so a snapshot always falls inside the +-2h window', () => {
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_INTERVAL_SECONDS: '30' })).toThrow(/60/);
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_INTERVAL_SECONDS: '20000' })).toThrow(/14400/);
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_INTERVAL_SECONDS: '1.5' })).toThrow();
  });
});
```

- [ ] **Step 2: Write the failing integration test** — `be/src/pools/tvlCapture.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { encodeAbiParameters, keccak256 } from 'viem';
import { __resetUsdPriceCacheForTests } from '../market/usdPricing.js';
import { captureTvlSnapshots, runSnapshotCycle } from './tvlCapture.js';
import { insertTvlSnapshot } from './tvlSnapshots.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const hook = '0x3333333333333333333333333333333333333333';
const feed = '0x4444444444444444444444444444444444444444';
const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [a, b, 3000, 60, hook],
));
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const now = 4000;

function clientWith(lens: unknown) {
  return {
    async getBlockNumber() { return 300n; },
    async readContract({ functionName, address }: { functionName: string; address: string }) {
      if (functionName === 'decimals') return address.toLowerCase() === feed ? 8 : 18;
      if (functionName === 'latestRoundData') return [1n, 400_000_000n, 0n, 4000n, 1n];
      if (functionName === 'getPoolTVL') { if (lens instanceof Error) throw lens; return lens; }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
}
const goodLens = { coreAmount0: 3n * 10n ** 18n, coreAmount1: 2n * 10n ** 18n, sqrtPriceX96: 2n ** 96n, hasCustomAccounting: false };
const rows = () => pool.query('SELECT quote_address, tvl_usd, block_number FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);

beforeAll(async () => {
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
    block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,99,$6,$7,0,true,'caught_up')
    ON CONFLICT (chain_id,protocol,pool_id) DO NOTHING`, [chainId, poolId, a, b, hook, tx('1'), tx('2')]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id,quote_asset_address,feed_address,discovery_source,verification_status,last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id,quote_asset_address) DO UPDATE SET
      feed_address=EXCLUDED.feed_address,verification_status='verified'`, [chainId, b, feed]);
});
beforeEach(() => { __resetUsdPriceCacheForTests(); });
afterEach(async () => { await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]); });
afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, poolId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id=$1 AND quote_asset_address=$2', [chainId, b]);
  await pool.end();
});

describe('captureTvlSnapshots', () => {
  it('records raw amounts and the USD TVL priced through the side that has a verified feed', async () => {
    const result = await captureTvlSnapshots(pool, clientWith(goodLens), now);
    expect(result).toEqual({ captured: 1, skipped: 0 });
    const stored = (await rows()).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].quote_address).toBe(b);
    expect(Number(stored[0].tvl_usd)).toBeCloseTo(20); // (2e18 quote + 3e18 token at price 1) x $4
  });
  it('writes nothing when the lens read fails or reports custom accounting', async () => {
    expect(await captureTvlSnapshots(pool, clientWith(new Error('rpc down')), now, () => {})).toEqual({ captured: 0, skipped: 1 });
    expect(await captureTvlSnapshots(pool, clientWith({ ...goodLens, hasCustomAccounting: true }), now)).toEqual({ captured: 0, skipped: 1 });
    expect(await captureTvlSnapshots(pool, clientWith({ ...goodLens, sqrtPriceX96: 0n }), now)).toEqual({ captured: 0, skipped: 1 });
    expect((await rows()).rows).toHaveLength(0);
  });
});

describe('runSnapshotCycle', () => {
  it('still prunes old snapshots when every capture failed', async () => {
    await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 1n, capturedAtSeconds: now - 10 * 3600,
      coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '1' });
    await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 2n, capturedAtSeconds: now - 3600,
      coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '2' });
    const result = await runSnapshotCycle(pool, clientWith(new Error('rpc down')), { intervalSeconds: 3600, retentionHours: 26 }, now + 40 * 3600);
    expect(result).toEqual({ captured: 0, skipped: 1, pruned: 2 });
  });
  it('keeps snapshots inside the retention window', async () => {
    await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 1n, capturedAtSeconds: now - 20 * 3600,
      coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '1' });
    const result = await runSnapshotCycle(pool, clientWith(goodLens), { intervalSeconds: 3600, retentionHours: 26 }, now);
    expect(result).toEqual({ captured: 1, skipped: 0, pruned: 0 });
    expect((await rows()).rows).toHaveLength(2);
  });
});
```

(The first `runSnapshotCycle` test's `now + 40h` makes both seeded rows older than 26h; the failing client captures nothing, yet `pruned` is 2.)

- [ ] **Step 3: Run both to verify they fail**

Run: `cd be && npx vitest run src/pools/tvlCapture.test.ts; npx vitest run --config vitest.integration.config.ts src/pools/tvlCapture.integration.test.ts`
Expected: FAIL (`./tvlCapture.js` not found).

- [ ] **Step 4: Implement** — `be/src/pools/tvlCapture.ts`:

```ts
import type { Pool } from 'pg';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { calculateTvlUsd } from '../market/tvlValue.js';
import { readUsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { readLensSnapshot } from './lens.js';
import { assetDecimals } from './stats.js';
import { insertTvlSnapshot, pruneTvlSnapshots } from './tvlSnapshots.js';

export const MIN_RETENTION_HOURS = 26;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 14_400;

export interface SnapshotConfig { intervalSeconds: number; retentionHours: number }

export function parseSnapshotConfig(env: Record<string, string | undefined>): SnapshotConfig {
  const intervalSeconds = Number(env.POOL_TVL_SNAPSHOT_INTERVAL_SECONDS ?? 3600);
  const retentionHours = Number(env.POOL_TVL_SNAPSHOT_RETENTION_HOURS ?? 168);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`POOL_TVL_SNAPSHOT_INTERVAL_SECONDS must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} so a snapshot always falls inside the 24h comparison window`);
  }
  if (!Number.isFinite(retentionHours) || retentionHours < MIN_RETENTION_HOURS) {
    throw new Error(`POOL_TVL_SNAPSHOT_RETENTION_HOURS must be >= ${MIN_RETENTION_HOURS} so pruning can never delete the snapshot the 24h comparison needs`);
  }
  return { intervalSeconds, retentionHours };
}

interface CatalogRow { chain_id: number; pool_id: string; currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }

async function captureOne(pool: Pool, client: UsdPriceClient, row: CatalogRow, nowSeconds: number): Promise<boolean> {
  const quoteAddress = (await resolveVerifiedFeed(pool, row.chain_id, row.currency0)) ? row.currency0
    : (await resolveVerifiedFeed(pool, row.chain_id, row.currency1)) ? row.currency1 : null;
  if (quoteAddress === null) return false;
  const quoteIsCurrency0 = quoteAddress === row.currency0;
  const [decimals0, decimals1] = await Promise.all([assetDecimals(client, row.currency0), assetDecimals(client, row.currency1)]);
  if (decimals0 === null || decimals1 === null) return false;
  const quoteUsd = await readUsdPrice(pool, client, quoteAddress, () => nowSeconds * 1000);
  if (!quoteUsd) return false;
  const lens = await readLensSnapshot(client, row);
  if (!lens) return false;
  const tvlUsd = calculateTvlUsd({
    tokenRaw: quoteIsCurrency0 ? lens.coreAmount1 : lens.coreAmount0,
    quoteRaw: quoteIsCurrency0 ? lens.coreAmount0 : lens.coreAmount1,
    blockNumber: lens.blockNumber, basis: 'pool_principal', sqrtPriceX96: lens.sqrtPriceX96,
    tokenIsCurrency0: !quoteIsCurrency0,
  }, quoteIsCurrency0 ? decimals0 : decimals1, quoteIsCurrency0 ? decimals1 : decimals0, quoteUsd.priceUsd);
  if (tvlUsd === null) return false;
  await insertTvlSnapshot(pool, {
    chainId: row.chain_id, protocol: 'uniswap_v4', poolId: row.pool_id, blockNumber: lens.blockNumber,
    capturedAtSeconds: nowSeconds, coreAmount0Raw: lens.coreAmount0, coreAmount1Raw: lens.coreAmount1,
    sqrtPriceX96: lens.sqrtPriceX96, quoteAddress, tvlUsd,
  });
  return true;
}

/** One pass over every verified V4 pool. A pool that cannot be read or priced is skipped, never stored as a guess. */
export async function captureTvlSnapshots(pool: Pool, client: UsdPriceClient, nowSeconds: number,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): Promise<{ captured: number; skipped: number }> {
  const pools = (await pool.query(`SELECT chain_id, pool_id, currency0, currency1, fee, tick_spacing, hooks
    FROM pool_catalog WHERE protocol='uniswap_v4' AND verified=true`)).rows as CatalogRow[];
  let captured = 0;
  let skipped = 0;
  for (const row of pools) {
    try {
      if (await captureOne(pool, client, row, nowSeconds)) captured += 1; else skipped += 1;
    } catch (error) {
      skipped += 1;
      log(`TVL snapshot failed for pool ${row.pool_id}`, error);
    }
  }
  return { captured, skipped };
}

/** Capture, then prune — pruning runs even if the capture pass throws, so an outage cannot grow the table. */
export async function runSnapshotCycle(pool: Pool, client: UsdPriceClient, config: SnapshotConfig,
  nowSeconds: number): Promise<{ captured: number; skipped: number; pruned: number }> {
  let result = { captured: 0, skipped: 0 };
  let pruned = 0;
  try {
    result = await captureTvlSnapshots(pool, client, nowSeconds);
  } finally {
    pruned = await pruneTvlSnapshots(pool, nowSeconds - config.retentionHours * 3600);
  }
  return { ...result, pruned };
}
```

Export `assetDecimals` is already exported from `stats.ts` — no change needed there.

- [ ] **Step 5: Create the worker** — `be/src/cli/runPoolTvlSnapshotWorker.ts`:

```ts
import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { parseSnapshotConfig, runSnapshotCycle } from '../pools/tvlCapture.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const config = parseSnapshotConfig(process.env);
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      const result = await runSnapshotCycle(pool, client, config, Math.floor(Date.now() / 1000));
      console.log(`Pool TVL snapshots: captured=${result.captured} skipped=${result.skipped} pruned=${result.pruned}`);
    } catch (error) {
      console.error('Pool TVL snapshot cycle failed; retrying next interval:', error);
    }
    for (let waited = 0; waited < config.intervalSeconds && !stopping; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
} finally { await pool.end(); }
```

Add to `be/package.json` scripts, next to `pools:candles:worker`:
`"pools:tvl-snapshots:worker": "tsx --env-file-if-exists=.env src/cli/runPoolTvlSnapshotWorker.ts",`

- [ ] **Step 6: Run to verify it passes**

Run: `cd be && npx tsc --noEmit && npx vitest run src/pools/tvlCapture.test.ts && npx vitest run --config vitest.integration.config.ts src/pools/tvlCapture.integration.test.ts && npx eslint src/pools src/cli/runPoolTvlSnapshotWorker.ts`
Expected: all pass, eslint clean for these files.

- [ ] **Step 7: Commit**

```bash
cd /Users/long/Development/Launchpad-Aggregator
git add be/src/pools/tvlCapture.ts be/src/pools/tvlCapture.test.ts be/src/pools/tvlCapture.integration.test.ts be/src/cli/runPoolTvlSnapshotWorker.ts be/package.json
git commit -m "feat: add hourly pool TVL snapshot worker with retention" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Expose `tvlChange` in API and show it in the UI

**Files:**
- Modify: `be/src/pools/stats.ts` (`PoolStats`, `readPoolStats`)
- Modify: `be/src/pools/stats.integration.test.ts`
- Modify: `be/src/api/schemas.ts`, `be/src/api/pools.test.ts`
- Regenerate: `be/openapi.json`, `fe/src/api/schema.ts`
- Modify: `fe/src/features/pools/pool-stats.tsx`, `fe/src/features/pools/pool-detail.tsx`
- Modify (fixtures): `fe/src/features/pools/pools.test.tsx`, `fe/src/features/launch/launch-detail.test.tsx`, `fe/e2e/mock-api.ts`

**Interfaces:**
- Consumes: `readTvlChange` (Task 3).
- Produces: `PoolStats.tvlChange: string | null`; API `tvlChange` (nullable string) on pool summary; `PoolStatsProps.tvlChange?: string | null`.

- [ ] **Step 1: Write the failing BE integration test** — in `be/src/pools/stats.integration.test.ts` add (imports: add `insertTvlSnapshot` from `./tvlSnapshots.js`) inside `describe('readPoolStats', …)`:

```ts
  it('reports the TVL change against the snapshot taken ~24h earlier through the same quote asset', async () => {
    await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 5n, capturedAtSeconds: 1600,
      coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '25' });
    try {
      const stats = await readPoolStats(pool, key, a, 88_000, { rpcClient });
      expect(stats.tvlUsd).toBe('20');
      expect(Number(stats.tvlChange)).toBeCloseTo(-20);
      const noSnapshot = await readPoolStats(pool, key, a, 4000, { rpcClient });
      expect(noSnapshot.tvlChange).toBeNull();
    } finally {
      await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
    }
  });
```

Also add `await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);` to `afterAll` before `pool.end()`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && npx vitest run --config vitest.integration.config.ts src/pools/stats.integration.test.ts`
Expected: FAIL (`tvlChange` undefined).

- [ ] **Step 3: Implement BE.** In `be/src/pools/stats.ts`: add `import { readTvlChange } from './tvlSnapshots.js';`; add `tvlChange: string | null;` to `PoolStats` right after `tvlUsd`; after the `poolSnapshot` computation add:

```ts
  const tvlChange = complete && key.protocol === 'uniswap_v4'
    ? await readTvlChange(pool, key, quoteAddress, poolSnapshot.tvlUsd, asOf) : null;
```

and in the returned object add `tvlChange,` next to `tvlUsd`. In `be/src/api/schemas.ts` change `tvlUsd: nullableMetric,` to `tvlUsd: nullableMetric, tvlChange: nullableMetric,` in `poolSummary`. In `be/src/api/pools.test.ts` add `tvlChange: null,` next to `volume24hChange: null,`.

- [ ] **Step 4: Run BE checks and regenerate the API types**

Run:
```bash
cd be && npx tsc --noEmit && npx vitest run && npx vitest run --config vitest.integration.config.ts src/pools src/api/pools.integration.test.ts
npm run openapi:write && cd ../fe && npm run generate:schema
```
Expected: stats integration passes; `tsc` clean. (One pre-existing BE failure in `src/coverage/sourceRegistryCheck.test.ts` is unrelated — it compares against the user's uncommitted `envio/config.yaml`.) `git diff be/openapi.json fe/src/api/schema.ts` shows only `tvlChange` additions (plus the earlier `volume24hChange`).

- [ ] **Step 5: Write the failing FE test** — in `fe/src/features/pools/pools.test.tsx`, next to the volume-change test:

```tsx
  it('PoolDetail shows the TVL change vs 24h ago, and a dash when unavailable', () => {
    const { unmount } = render(<PoolDetail pool={{ ...pool, tvlUsd: '886100', tvlChange: '-13.38' }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByTestId('tvl-change').textContent).toContain('13.38%');
    expect(screen.getByTestId('tvl-change').textContent).toContain('▼');
    unmount();
    render(<PoolDetail pool={{ ...pool, tvlChange: null }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByTestId('tvl-change').textContent).toBe('—');
  });
```

Add `tvlChange: null,` next to `volume24hChange: null,` in the fixtures of `fe/src/features/pools/pools.test.tsx` and `fe/src/features/launch/launch-detail.test.tsx`, and `tvlChange: null,` after the `volume24hChange` line in `fe/e2e/mock-api.ts`'s pool mock.

Run: `cd fe && npx vitest run src/features/pools/pools.test.tsx -t "TVL change"`
Expected: FAIL (no element `tvl-change`).

- [ ] **Step 6: Implement FE.** In `fe/src/features/pools/pool-stats.tsx`: add prop `tvlChange?: string | null;` (comment: `// Percent change vs 24h ago; null renders "—" (unavailable, not 0%).`), destructure `tvlChange = null`, and change the TVL cell to:

```tsx
<div><dt className="text-sm text-muted-foreground">TVL</dt><dd className="text-lg font-semibold">{formatPoolUsd(tvlUsd)}<span data-testid="tvl-change" className="ml-2 text-sm font-normal"><PercentChange value={tvlChange} /></span></dd></div>
```

In `fe/src/features/pools/pool-detail.tsx` add `tvlChange={pool.tvlChange}` after `volume24hChange={pool.volume24hChange}`.

- [ ] **Step 7: Verify**

Run: `cd fe && npx tsc --noEmit && npx vitest run src/features/pools`
Expected: `tsc` clean; the new test and the volume-change test pass. (`defaults to currency0 globally…` "Pons designated pool" fails before and after this work; it is unrelated.)

- [ ] **Step 8: Commit**

BE files (clean before this plan):
```bash
cd /Users/long/Development/Launchpad-Aggregator
git add be/src/pools/stats.ts be/src/pools/stats.integration.test.ts be/src/api/schemas.ts be/src/api/pools.test.ts be/openapi.json
git commit -m "feat: expose pool tvlChange vs 24h-ago snapshot" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
FE files: run `git diff --stat fe/src/features/pools/pool-stats.tsx fe/src/features/pools/pool-detail.tsx fe/src/api/schema.ts fe/src/features/pools/pools.test.tsx fe/src/features/launch/launch-detail.test.tsx fe/e2e/mock-api.ts`. These had user edits before this work, so do **not** commit them; list them in the final report so the user can commit them with their own changes.

- [ ] **Step 9: Document the worker** — add a short subsection to `README.md` (Vietnamese is fine) next to the other worker commands: `npm run pools:tvl-snapshots:worker` (cần `DATABASE_URL`, `RH_HTTP_RPC_URL`; tùy chọn `POOL_TVL_SNAPSHOT_INTERVAL_SECONDS` mặc định 3600, `POOL_TVL_SNAPSHOT_RETENTION_HOURS` mặc định 168, tối thiểu 26) and that TVL % shows "—" for the first ~24h after the worker starts. Commit only if `git diff README.md` shows nothing but your lines; otherwise leave it uncommitted and report it.

---

## Self-review notes

- **Spec coverage:** table (Task 3), worker + retention + config guards (Task 4), read path with ±2h/quote check (Tasks 3, 5), API schema + regen (Task 5), FE (Task 5), tests listed in the spec's Testing section (Tasks 1, 3, 4, 5), ops note/npm script (Task 4, README step).
- **Type consistency:** `percentChange` (Task 1) is used by `readTvlChange` (Task 3) and `stats.ts` (Task 1); `readLensSnapshot` (Task 2) is used by `stats.ts` and `tvlCapture.ts`; `insertTvlSnapshot`/`pruneTvlSnapshots`/`readTvlChange` signatures are identical across Tasks 3–5; `SnapshotConfig` fields `intervalSeconds`/`retentionHours` match in the worker and tests.
- **Known limitation, intentional:** snapshots exist only for pools where one side has a verified USD feed; others get no row and show "—".
