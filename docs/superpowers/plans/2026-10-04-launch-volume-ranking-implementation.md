# Launch Volume Ranking (Global 24h USD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client-side "Trending" sort with two tabs — `All` (globally ranked by official 24h USD volume, valued at each trade's own historical quote price) and `Recently launched` (unchanged recency order) — backed by a persisted Chainlink feed registry and historical price-round store that the future `Pools` work unit can reuse.

**Architecture:** A new `be/src/market/quotePricing/` module owns quote/USD pricing end-to-end: a persisted feed registry (`quote_usd_feeds`) replaces the hardcoded `FEEDS` map and in-memory `quoteFeedRegistry.ts`; a persisted historical round store (`quote_usd_price_rounds`) replaces "latest price only"; one shared valuation routine prices a trade using the newest round at-or-before that trade's exact `(blockNumber, logIndex)` position. Feed discovery and round backfill run as bounded, retryable background jobs in a new small job table (`price_jobs`), processed by a periodic loop in the same BE process that already runs Envio-sync — never the deleted RPC-scan indexer's write path, never per-trade RPC calls. Round backfill is a bounded `eth_getLogs` scan against each feed's underlying Chainlink *aggregator* contract (not the proxy — verified live that `AnswerUpdated` is only emitted there), not a new Envio contract, because feed discovery is triggered off-chain and the real event volume is small (verified live: 66 `AnswerUpdated` logs in ~2 days for the ETH/USD feed). `listLaunches` gains a `sort=volume24hUsd|recent` parameter; the USD-ranked path is a read-side query first, gated by a mandatory benchmark task against representative-sized synthetic data before being accepted.

**Tech Stack:** TypeScript, viem, PostgreSQL, Drizzle, Fastify, Next.js, Tailwind, Vitest.

**Spec:** [docs/superpowers/specs/2026-10-04-launch-volume-ranking-design.md](../specs/2026-10-04-launch-volume-ranking-design.md)

## Context carried into this plan (verified live this session, not re-derived)

- **Chainlink historical rounds are available far past the 24h need.** Live `getRoundData` probes against the three real feeds on Robinhood Chain (ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, USDG/USD `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`, NVDA/USD `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`) returned real historical data back ~103, ~100, and ~58 days respectively (all `phaseId()` = 1 — no aggregator rotation has happened yet for any of them).
- **`AnswerUpdated` is emitted by the feed's underlying *aggregator* contract, not the proxy address everyone reads prices from.** Live-verified: 0 logs at the ETH/USD proxy across a 2M-block scan; 66 real logs at its aggregator (`0x6091E64eb7138EEF066a80FD3A0d7427B91f2721`, found by calling `aggregator()` on the proxy — a standard function every Chainlink proxy exposes) in the same window. Every feed used in this plan must resolve its aggregator address this way before backfilling rounds; must tolerate the aggregator address changing if Chainlink ever rotates phases (none have yet).
- **The old RPC-scan indexer is fully removed this session.** `be/src/db/repository.ts`, `be/src/cli/runFactoryIndexer.ts`, and everything under the deleted `be/src/indexer/*` modules no longer exist. Envio (`be/src/envioSync/`) is the only indexing path. Nothing in this plan may import from or resurrect that subsystem.
- **Envio's raw ingestion already captures every pool unfiltered** (confirmed via git history + live file read: no `where` filter was ever wired into `UniswapV4PoolManager`'s handlers). The BE's Pons sync still deliberately promotes only Pons-graduated+verified V4 pools into a *launch's own* official venue history — unrelated and unchanged by this plan. The `Pools` (other pools) feature itself is out of scope here (see spec's own "Out of scope").
- **This project already has a proven lease/retry background-job pattern** for exactly this kind of problem: `be/src/launchpads/pons/metadataEnrichmentStore.ts` (claim-with-lease, exponential backoff via `nextMetadataRetryAt`, a singleton budget row to avoid overlapping passes) driven by `be/src/launchpads/pons/metadataEnrichment.ts`'s `startMetadataEnrichmentLoop`, started from `be/src/cli/syncEnvioStagingLoop.ts`. This plan's `price_jobs` table and worker mirror that pattern — **not** the deleted `scan_jobs` (block-range-shaped, tied to the old indexer).
- User-confirmed decisions this session: don't limit how far back a user can browse trade history (handle missing historical prices via the bounded/deduplicated backfill-job pattern, never block the page); use one new small `price_jobs` table, not `scan_jobs`; defer the performance benchmark to this plan's own execution (included below as Task 11) rather than a pre-check.

## Global Constraints

- Never fabricate a price or a rank: a `null`/`pending`/`unavailable` stays exactly that end-to-end (DB → API → FE). `officialVolume24hUsd` is `null` whenever any positive-value trade in the window lacks a verified historical price — never an understated partial sum.
- A known zero-trade window with complete coverage is USD volume `0` (a real, affirmed zero) — never confused with `null` (unknown/incomplete).
- Only use official trading venues for a launch's own volume/rank (`venues.official = true`) — unrelated to the separate, out-of-scope `Pools` (other pools) feature.
- Match by chain and exact asset **address**, never symbol alone, for every feed lookup.
- No per-trade RPC calls, ever. No synchronous RPC inside an API request handler. Feed discovery and round backfill are background jobs with durable retry state — a transient RPC failure must not become a permanent `unavailable`/`null`.
- Never resurrect anything from the deleted RPC-scan indexer (`be/src/db/repository.ts`, `be/src/indexer/*`, `scan_jobs`). New background-job code lives in the new `price_jobs` table and the existing Envio-sync-loop process only.
- Keep `officialVolume24h` (quote-unit) as-is; add `officialVolume24hUsd`/`officialVolume24hUsdApprox` alongside it — never replace or silently reinterpret the quote-unit field.
- Reuse one valuation routine for both the volume aggregate and individual `/trades` rows — never let the two disagree on a trade's USD value.
- The signed volume cursor is a distinct type from the existing recency/trade cursor (`be/src/api/cursor.ts`) — never mix the two, never let a caller reuse one sort's cursor on another sort.
- Historical trade prices never change after being computed from a verified round at-or-before that trade's `(blockNumber, logIndex)` — a later, better-positioned round backfill can only fill a previously-`pending` trade, never revise an already-`priced` one to a different value (the round selection is already the causally-correct one).

## Architecture decisions made while writing this plan (the spec left these to implementation judgment)

- **Round backfill mechanism: bounded `eth_getLogs` scans from the existing BE sync-loop process, not a new Envio contract.** Chainlink feed addresses are discovered off-chain (an external directory lookup), which doesn't fit Envio's on-chain-event-triggered `contractRegister` dynamic-registration pattern, and adding a feed to `envio/config.yaml`'s static address list would need an Envio redeploy per newly-verified feed. Real event volume is small (tens/day per feed, live-verified). This still satisfies the spec's "Envio-associated pricing workflow" by running in the same long-lived BE process (`syncEnvioStagingLoop.ts`) that already drives Envio sync and the metadata-enrichment loop, and it satisfies "no per-trade RPC reads" (it's per-feed-per-bounded-range, not per-trade) and "no legacy-indexer write path" (new code, not `repository.ts`).
- **`price_jobs` is one small table for two job types** (`feed_resolution`, `round_backfill`), not two tables — both need the same claim/lease/retry shape, and the two job kinds are mutually exclusive per row (enforced by a CHECK constraint on which columns are non-null for each `job_type`).
- **Round rows always carry a real `(block_number, log_index)`** — every round this plan ever persists comes from decoding a real `AnswerUpdated` log via `eth_getLogs`, never a per-round `getRoundData` call without position data. This simplifies the schema (no nullable position columns, no "if publication order cannot be proven" fallback branch — position is always known) versus the spec's more defensive phrasing.
- **Volume cursor signing uses `node:crypto`'s HMAC-SHA256** with a new required env var `VOLUME_CURSOR_SECRET` (no new dependency). This is integrity (tamper-evidence that the `asOf` window wasn't forged mid-pagination), not authentication.
- **The spec's optional "verified direct USD quote may use an explicitly documented 1:1 rule" is not implemented** — no quote asset in current real use (WETH/ETH, USDG, NVDA — all Chainlink-fed) needs it, and the spec itself gates it behind "only if its asset and the rule are trusted," which isn't a decision this plan can make up front for a hypothetical future asset. If a real USD-pegged quote asset shows up later with no Chainlink feed, add it as its own explicitly-reviewed addition to `quote_usd_feeds` (e.g. `discoverySource: 'manual-1:1-review'`), never as a generic "stable-looking symbol" rule in code.

## Review Focus

- A trade whose quote asset has a verified feed but whose exact round hasn't been backfilled yet must show `usdValueStatus: pending` (and enqueue a backfill job), never silently fall back to a current/approximate price — the old `listTrades` current-price fallback this plan removes was exactly this kind of shortcut.
- Two trades in the same launch's 24h window with genuinely different historical quote prices (e.g. the quote asset moved between them) must each be valued at their own trade-time price, and the volume sum must reflect that — not one price applied to both.
- A launch with real trades in its window where even one priced trade's historical round is missing/stale must rank as `null` (unavailable), never as a partial sum that silently undercounts.
- A newly observed quote-asset address with no trustworthy feed (spoofed symbol, unverified directory entry) must never acquire a feed by symbol-matching alone, and must stay `unavailable` indefinitely until a real verified feed appears — not retry forever into a fabricated match.
- A `sort=volume24hUsd` cursor must be rejected (not silently reinterpreted) if replayed against `sort=recent`, if tampered with, if expired, or if its `asOf` window would let a caller observe a ranking date they didn't start pagination with.

---

### Task 1: Persisted quote/USD feed registry — schema and resolution

**Files:**
- Create: `be/src/market/quotePricing/feedRegistry.ts`
- Test: `be/src/market/quotePricing/feedRegistry.test.ts`
- Modify: `be/src/db/schema.ts`
- Create: `be/drizzle/0021_<auto-generated-name>.sql` (via `db:generate`, do not hand-write)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export interface QuoteFeed { chainId: number; quoteAssetAddress: Address; feedAddress: Address; aggregatorAddress: Address | null; discoverySource: string; verificationStatus: 'verified' | 'unverified' | 'rejected' }`,
  `export async function resolveVerifiedFeed(pool: Pool, chainId: number, quoteAssetAddress: string): Promise<QuoteFeed | null>` — returns the row only if `verificationStatus === 'verified'`, else `null`. Address lookups are lowercased before comparison.
  `export async function upsertQuoteFeed(pool: Pool, feed: { chainId: number; quoteAssetAddress: Address; feedAddress: Address; aggregatorAddress: Address | null; discoverySource: string; verificationStatus: 'verified' | 'rejected'; now: Date }): Promise<void>` — idempotent upsert keyed by `(chainId, quoteAssetAddress)`.
  Drizzle table `quoteUsdFeeds` on `quote_usd_feeds`. Task 4 writes via `upsertQuoteFeed`; Task 7/9/10 read via `resolveVerifiedFeed`.

- [ ] **Step 1: Add the `quote_usd_feeds` table to the schema**

In `be/src/db/schema.ts`, add after the `metadataEnrichmentBudget` table:

```typescript
export const quoteUsdFeeds = pgTable('quote_usd_feeds', {
  chainId: integer('chain_id').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  feedAddress: text('feed_address').notNull(),
  aggregatorAddress: text('aggregator_address'),
  discoverySource: text('discovery_source').notNull(),
  verificationStatus: text('verification_status').notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.quoteAssetAddress] }),
  check('quote_usd_feeds_verification_status_valid', sql`${table.verificationStatus} IN ('verified', 'unverified', 'rejected')`),
]);
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd be && npm run db:generate`
Expected: a new `be/drizzle/0021_<name>.sql` with exactly one `CREATE TABLE "quote_usd_feeds" (...)` statement, no changes to any other table. Read it to confirm.

Run: `cd be && DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run db:migrate`
Run: `cd be && DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run db:migrate`
Expected: both apply cleanly with no errors.

- [ ] **Step 3: Write the failing tests**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { resolveVerifiedFeed, upsertQuoteFeed } from './feedRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const token = '0xfeed000000000000000000000000000000f001';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_feeds WHERE quote_asset_address = $1', [token]);
  await pool.end();
});

describe('feedRegistry', () => {
  it('returns null for an address with no row at all', async () => {
    expect(await resolveVerifiedFeed(pool, 4663, token)).toBeNull();
  });

  it('returns null for a row marked unverified or rejected, only returns a verified one', async () => {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: token, feedAddress: '0xfeedaddr00000000000000000000000000f002',
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'rejected', now: new Date() });
    expect(await resolveVerifiedFeed(pool, 4663, token)).toBeNull();

    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: token, feedAddress: '0xfeedaddr00000000000000000000000000f002',
      aggregatorAddress: '0xaggregator000000000000000000000000f003', discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
    const feed = await resolveVerifiedFeed(pool, 4663, token);
    expect(feed).toEqual({ chainId: 4663, quoteAssetAddress: token, feedAddress: '0xfeedaddr00000000000000000000000000f002',
      aggregatorAddress: '0xaggregator000000000000000000000000f003', discoverySource: 'test', verificationStatus: 'verified' });
  });

  it('matches by exact address only, case-insensitively, never by a different address', async () => {
    const feed = await resolveVerifiedFeed(pool, 4663, token.toUpperCase());
    expect(feed?.quoteAssetAddress).toBe(token);
    expect(await resolveVerifiedFeed(pool, 4663, '0x0000000000000000000000000000000000dead')).toBeNull();
  });

  it('upsert is idempotent and keyed by (chainId, quoteAssetAddress)', async () => {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: token, feedAddress: '0xnewfeed0000000000000000000000000000f9',
      aggregatorAddress: null, discoverySource: 'test-2', verificationStatus: 'verified', now: new Date() });
    const rows = await pool.query('SELECT count(*)::int AS count FROM quote_usd_feeds WHERE quote_asset_address = $1', [token]);
    expect(rows.rows[0].count).toBe(1);
    expect((await resolveVerifiedFeed(pool, 4663, token))?.feedAddress).toBe('0xnewfeed0000000000000000000000000000f9');
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/market/quotePricing/feedRegistry.test.ts`
Expected: FAIL — `Cannot find module './feedRegistry.js'`.

(This is an integration test — move it to run under `vitest.integration.config.ts`'s include pattern; check that config file's `include` glob and name the test file to match its existing convention for this directory, e.g. if the project's integration tests are named `*.integration.test.ts`, name this file `feedRegistry.integration.test.ts` instead and adjust every reference in this task accordingly.)

- [ ] **Step 5: Implement**

```typescript
import type { Pool } from 'pg';
import type { Address } from 'viem';

export interface QuoteFeed {
  chainId: number;
  quoteAssetAddress: Address;
  feedAddress: Address;
  aggregatorAddress: Address | null;
  discoverySource: string;
  verificationStatus: 'verified' | 'unverified' | 'rejected';
}

export async function resolveVerifiedFeed(pool: Pool, chainId: number, quoteAssetAddress: string): Promise<QuoteFeed | null> {
  const result = await pool.query(
    `SELECT chain_id, quote_asset_address, feed_address, aggregator_address, discovery_source, verification_status
     FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2 AND verification_status = 'verified'`,
    [chainId, quoteAssetAddress.toLowerCase()],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    chainId: Number(row.chain_id), quoteAssetAddress: String(row.quote_asset_address) as Address,
    feedAddress: String(row.feed_address) as Address,
    aggregatorAddress: row.aggregator_address === null ? null : String(row.aggregator_address) as Address,
    discoverySource: String(row.discovery_source), verificationStatus: row.verification_status as QuoteFeed['verificationStatus'],
  };
}

export async function upsertQuoteFeed(pool: Pool, feed: {
  chainId: number; quoteAssetAddress: Address; feedAddress: Address; aggregatorAddress: Address | null;
  discoverySource: string; verificationStatus: 'verified' | 'rejected'; now: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, aggregator_address, discovery_source, verification_status, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET
       feed_address = EXCLUDED.feed_address, aggregator_address = EXCLUDED.aggregator_address,
       discovery_source = EXCLUDED.discovery_source, verification_status = EXCLUDED.verification_status,
       last_checked_at = EXCLUDED.last_checked_at`,
    [feed.chainId, feed.quoteAssetAddress.toLowerCase(), feed.feedAddress.toLowerCase(),
      feed.aggregatorAddress?.toLowerCase() ?? null, feed.discoverySource, feed.verificationStatus, feed.now],
  );
}
```

- [ ] **Step 6: Run to verify they pass**

Run the same command as Step 4. Expected: PASS, 4/4.

- [ ] **Step 7: Commit**

```bash
git add be/src/db/schema.ts be/drizzle/0021_*.sql be/drizzle/meta/0021_snapshot.json be/drizzle/meta/_journal.json be/src/market/quotePricing/feedRegistry.ts be/src/market/quotePricing/feedRegistry.integration.test.ts
git commit -m "feat: add persisted quote/USD feed registry table and resolver"
```

---

### Task 2: Historical price-round store and causally-prior round selection

**Files:**
- Create: `be/src/market/quotePricing/priceRounds.ts`
- Test: `be/src/market/quotePricing/priceRounds.integration.test.ts`
- Modify: `be/src/db/schema.ts`
- Create: `be/drizzle/0022_<auto-generated-name>.sql`

**Interfaces:**
- Consumes: nothing from other tasks (independent of Task 1's feed registry — this task only stores/selects rounds for a given `feedAddress` string).
- Produces: `export interface PriceRound { roundId: bigint; answerRaw: bigint; decimals: number; startedAt: number; updatedAt: number; blockNumber: bigint; logIndex: number }`,
  `export async function upsertPriceRounds(pool: Pool, chainId: number, feedAddress: string, rounds: readonly PriceRound[]): Promise<number>` — bulk idempotent insert, returns count of newly-inserted rows.
  `export async function findRoundAtOrBefore(pool: Pool, chainId: number, feedAddress: string, blockNumber: bigint, logIndex: number): Promise<PriceRound | null>` — the newest round at or before that exact position. Task 6/9/10 call this.

- [ ] **Step 1: Add the `quote_usd_price_rounds` table**

In `be/src/db/schema.ts`, add after `quoteUsdFeeds`:

```typescript
export const quoteUsdPriceRounds = pgTable('quote_usd_price_rounds', {
  chainId: integer('chain_id').notNull(),
  feedAddress: text('feed_address').notNull(),
  roundId: numeric('round_id', { precision: 30, scale: 0 }).notNull(),
  answerRaw: numeric('answer_raw', { precision: 78, scale: 0 }).notNull(),
  decimals: integer('decimals').notNull(),
  startedAt: integer('started_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  logIndex: integer('log_index').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.feedAddress, table.roundId] }),
  index('quote_usd_price_rounds_position_idx').on(table.chainId, table.feedAddress, table.blockNumber, table.logIndex),
]);
```

- [ ] **Step 2: Generate and apply**

Run: `cd be && npm run db:generate`
Expected: `be/drizzle/0022_<name>.sql` with exactly one `CREATE TABLE "quote_usd_price_rounds"` plus its index, nothing else.

Apply to both dev and test DBs as in Task 1 Step 2.

- [ ] **Step 3: Write the failing tests**

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { findRoundAtOrBefore, upsertPriceRounds } from './priceRounds.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const feed = '0xfeedround0000000000000000000000000f001';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [feed]);
  await pool.end();
});

describe('priceRounds', () => {
  it('inserts rounds and finds the newest one at or before an exact position', async () => {
    const inserted = await upsertPriceRounds(pool, 4663, feed, [
      { roundId: 1n, answerRaw: 100_000_000n, decimals: 8, startedAt: 1000, updatedAt: 1000, blockNumber: 100n, logIndex: 1 },
      { roundId: 2n, answerRaw: 200_000_000n, decimals: 8, startedAt: 2000, updatedAt: 2000, blockNumber: 200n, logIndex: 1 },
      { roundId: 3n, answerRaw: 300_000_000n, decimals: 8, startedAt: 3000, updatedAt: 3000, blockNumber: 300n, logIndex: 1 },
    ]);
    expect(inserted).toBe(3);

    expect((await findRoundAtOrBefore(pool, 4663, feed, 250n, 0))?.answerRaw).toBe(200_000_000n);
    expect((await findRoundAtOrBefore(pool, 4663, feed, 200n, 1))?.answerRaw).toBe(200_000_000n);
    expect(await findRoundAtOrBefore(pool, 4663, feed, 50n, 0)).toBeNull();
  });

  it('resolves a same-block tie by log index, not by insertion order', async () => {
    await upsertPriceRounds(pool, 4663, feed, [
      { roundId: 10n, answerRaw: 400_000_000n, decimals: 8, startedAt: 4000, updatedAt: 4000, blockNumber: 400n, logIndex: 5 },
      { roundId: 11n, answerRaw: 500_000_000n, decimals: 8, startedAt: 4001, updatedAt: 4001, blockNumber: 400n, logIndex: 2 },
    ]);
    expect((await findRoundAtOrBefore(pool, 4663, feed, 400n, 5))?.answerRaw).toBe(400_000_000n);
    expect((await findRoundAtOrBefore(pool, 4663, feed, 400n, 3))?.answerRaw).toBe(500_000_000n);
  });

  it('is idempotent on re-insert of the same rounds', async () => {
    const second = await upsertPriceRounds(pool, 4663, feed, [
      { roundId: 1n, answerRaw: 100_000_000n, decimals: 8, startedAt: 1000, updatedAt: 1000, blockNumber: 100n, logIndex: 1 },
    ]);
    expect(second).toBe(0);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/market/quotePricing/priceRounds.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

```typescript
import type { Pool } from 'pg';

export interface PriceRound {
  roundId: bigint; answerRaw: bigint; decimals: number; startedAt: number; updatedAt: number;
  blockNumber: bigint; logIndex: number;
}

export async function upsertPriceRounds(pool: Pool, chainId: number, feedAddress: string, rounds: readonly PriceRound[]): Promise<number> {
  if (rounds.length === 0) return 0;
  let inserted = 0;
  for (const round of rounds) {
    const result = await pool.query(
      `INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chain_id, feed_address, round_id) DO NOTHING`,
      [chainId, feedAddress.toLowerCase(), round.roundId.toString(), round.answerRaw.toString(), round.decimals,
        round.startedAt, round.updatedAt, round.blockNumber.toString(), round.logIndex],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export async function findRoundAtOrBefore(pool: Pool, chainId: number, feedAddress: string, blockNumber: bigint, logIndex: number): Promise<PriceRound | null> {
  const result = await pool.query(
    `SELECT round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index FROM quote_usd_price_rounds
     WHERE chain_id = $1 AND feed_address = $2 AND (block_number, log_index) <= ($3, $4)
     ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    [chainId, feedAddress.toLowerCase(), blockNumber.toString(), logIndex],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    roundId: BigInt(String(row.round_id)), answerRaw: BigInt(String(row.answer_raw)), decimals: Number(row.decimals),
    startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
    blockNumber: BigInt(String(row.block_number)), logIndex: Number(row.log_index),
  };
}
```

- [ ] **Step 6: Run to verify they pass**

Run the Step 4 command. Expected: PASS, 3/3.

- [ ] **Step 7: Commit**

```bash
git add be/src/db/schema.ts be/drizzle/0022_*.sql be/drizzle/meta/0022_snapshot.json be/drizzle/meta/_journal.json be/src/market/quotePricing/priceRounds.ts be/src/market/quotePricing/priceRounds.integration.test.ts
git commit -m "feat: add historical price-round store with causally-prior round selection"
```

---

### Task 3: Shared trade-valuation routine

**Files:**
- Create: `be/src/market/quotePricing/tradeValuation.ts`
- Test: `be/src/market/quotePricing/tradeValuation.test.ts`

**Interfaces:**
- Consumes: `resolveVerifiedFeed` (Task 1), `findRoundAtOrBefore` (Task 2).
- Produces: `export type TradeUsdValuation = { status: 'priced'; usdValue: string } | { status: 'pending' } | { status: 'unavailable' }`,
  `export interface TradeForValuation { timestamp: number; quoteAmountRaw: bigint; quoteAssetDecimals: number; blockNumber: bigint; logIndex: number }`,
  `export async function valueTradeUsd(pool: Pool, chainId: number, quoteAssetAddress: string, trade: TradeForValuation): Promise<TradeUsdValuation>` — Tasks 7/9/10 call this for every trade valuation (volume aggregate and `/trades` rows alike), so the two can never disagree.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import * as feedRegistry from './feedRegistry.js';
import * as priceRounds from './priceRounds.js';
import { valueTradeUsd } from './tradeValuation.js';

vi.mock('./feedRegistry.js');
vi.mock('./priceRounds.js');

const chainId = 4663;
const quote = '0xquote00000000000000000000000000000f001';
const trade = { timestamp: 2000, quoteAmountRaw: 1_000_000_000_000_000_000n, quoteAssetDecimals: 18, blockNumber: 200n, logIndex: 1 };

describe('valueTradeUsd', () => {
  it('returns unavailable when there is no verified feed for the quote asset', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue(null);
    const result = await valueTradeUsd({} as never, chainId, quote, trade);
    expect(result).toEqual({ status: 'unavailable' });
  });

  it('returns pending when a verified feed exists but no round is backfilled at or before this trade yet', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore).mockResolvedValue(null);
    expect(await valueTradeUsd({} as never, chainId, quote, trade)).toEqual({ status: 'pending' });
  });

  it('returns pending (not a fabricated value) when the found round is older than the 24h freshness ceiling at trade time', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore).mockResolvedValue({ roundId: 1n, answerRaw: 100_000_000n, decimals: 8,
      startedAt: 0, updatedAt: 0, blockNumber: 1n, logIndex: 0 }); // updatedAt=0, trade.timestamp=2000 — fine within 24h here, use a real stale case below
    const staleTrade = { ...trade, timestamp: 2000 + 25 * 3600 };
    expect(await valueTradeUsd({} as never, chainId, quote, staleTrade)).toEqual({ status: 'pending' });
  });

  it('prices the trade using the found round, never the latest/current price', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore).mockResolvedValue({ roundId: 1n, answerRaw: 300_000_000_000n, decimals: 8,
      startedAt: 1999, updatedAt: 1999, blockNumber: 199n, logIndex: 0 }); // 3000.00000000 USD/quote
    const result = await valueTradeUsd({} as never, chainId, quote, trade); // 1.0 quote unit traded
    expect(result).toEqual({ status: 'priced', usdValue: '3000' });
  });

  it('two trades with different historical prices value independently, never sharing one price', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore)
      .mockResolvedValueOnce({ roundId: 1n, answerRaw: 100_000_000_000n, decimals: 8, startedAt: 1000, updatedAt: 1000, blockNumber: 100n, logIndex: 0 })
      .mockResolvedValueOnce({ roundId: 2n, answerRaw: 500_000_000_000n, decimals: 8, startedAt: 3000, updatedAt: 3000, blockNumber: 300n, logIndex: 0 });
    const early = await valueTradeUsd({} as never, chainId, quote, { ...trade, timestamp: 1000, blockNumber: 100n });
    const later = await valueTradeUsd({} as never, chainId, quote, { ...trade, timestamp: 3000, blockNumber: 300n });
    expect(early).toEqual({ status: 'priced', usdValue: '1000' });
    expect(later).toEqual({ status: 'priced', usdValue: '5000' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd be && npx vitest run src/market/quotePricing/tradeValuation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { formatUnits } from 'viem';
import type { Pool } from 'pg';
import { resolveVerifiedFeed } from './feedRegistry.js';
import { findRoundAtOrBefore } from './priceRounds.js';

// Same conservative ceiling as the existing latest-price reader (be/src/market/usdPricing.ts) —
// a round older than this at the TRADE's own timestamp (not "now") is rejected, never fabricated.
const MAX_PRICE_AGE_SECONDS = 24 * 60 * 60;

export type TradeUsdValuation = { status: 'priced'; usdValue: string } | { status: 'pending' } | { status: 'unavailable' };

export interface TradeForValuation {
  timestamp: number; quoteAmountRaw: bigint; quoteAssetDecimals: number; blockNumber: bigint; logIndex: number;
}

export async function valueTradeUsd(pool: Pool, chainId: number, quoteAssetAddress: string, trade: TradeForValuation): Promise<TradeUsdValuation> {
  const feed = await resolveVerifiedFeed(pool, chainId, quoteAssetAddress);
  if (!feed) return { status: 'unavailable' };
  const round = await findRoundAtOrBefore(pool, chainId, feed.feedAddress, trade.blockNumber, trade.logIndex);
  if (!round) return { status: 'pending' };
  const ageSeconds = trade.timestamp - round.updatedAt;
  if (ageSeconds < 0 || ageSeconds > MAX_PRICE_AGE_SECONDS) return { status: 'pending' };
  const quoteAmount = Number(formatUnits(trade.quoteAmountRaw, trade.quoteAssetDecimals));
  const priceUsd = Number(round.answerRaw) / 10 ** round.decimals;
  return { status: 'priced', usdValue: (quoteAmount * priceUsd).toString() };
}
```

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command. Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add be/src/market/quotePricing/tradeValuation.ts be/src/market/quotePricing/tradeValuation.test.ts
git commit -m "feat: add shared historical trade-USD-valuation routine"
```

---

### Task 4: Price job table — schema and claim/finish/retry store

**Files:**
- Create: `be/src/market/quotePricing/priceJobStore.ts`
- Test: `be/src/market/quotePricing/priceJobStore.integration.test.ts`
- Modify: `be/src/db/schema.ts`
- Create: `be/drizzle/0023_<auto-generated-name>.sql`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export interface PriceJob { id: string; jobType: 'feed_resolution' | 'round_backfill'; quoteAssetAddress: string | null; feedAddress: string | null; rangeStart: number | null; rangeEnd: number | null; attempts: number; leaseId: string }`,
  `export async function enqueueFeedResolutionJob(pool: Pool, chainId: number, quoteAssetAddress: string): Promise<void>` — dedup via `ON CONFLICT DO NOTHING`. Task 5's sync-hook calls this.
  `export async function enqueueRoundBackfillJob(pool: Pool, chainId: number, feedAddress: string, rangeStart: number, rangeEnd: number): Promise<void>` — dedup on the exact `(chainId, feedAddress, rangeStart, rangeEnd)` tuple. Task 6/10/11 call this.
  `export async function claimDuePriceJobs(pool: Pool, now: Date, limit: number, leaseMs: number): Promise<PriceJob[]>`, `export async function finishPriceJob(pool: Pool, job: PriceJob, outcome: { ok: true } | { ok: false; errorKind: 'transport' | 'unknown' | 'rejected'; error: string }, now: Date): Promise<boolean>` — mirrors `be/src/launchpads/pons/metadataEnrichmentStore.ts`'s claim/finish/lease shape. `'rejected'` marks the job permanently `failed` (no further retry — e.g. a feed-resolution job that definitively found no trustworthy feed); `'transport'`/`'unknown'` retry with backoff.

- [ ] **Step 1: Add the `price_jobs` table**

```typescript
export const priceJobs = pgTable('price_jobs', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  jobType: text('job_type').notNull(),
  quoteAssetAddress: text('quote_asset_address'),
  feedAddress: text('feed_address'),
  rangeStart: integer('range_start'),
  rangeEnd: integer('range_end'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  leaseId: text('lease_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('price_jobs_dedup_idx').on(table.chainId, table.jobType, table.quoteAssetAddress, table.feedAddress, table.rangeStart, table.rangeEnd),
  index('price_jobs_claim_idx').on(table.status, table.nextAttemptAt, table.leaseUntil),
  check('price_jobs_valid_type', sql`${table.jobType} IN ('feed_resolution', 'round_backfill')`),
  check('price_jobs_valid_status', sql`${table.status} IN ('pending', 'done', 'failed')`),
  check('price_jobs_type_shape', sql`
    (${table.jobType} = 'feed_resolution' AND ${table.quoteAssetAddress} IS NOT NULL AND ${table.feedAddress} IS NULL)
    OR (${table.jobType} = 'round_backfill' AND ${table.feedAddress} IS NOT NULL AND ${table.rangeStart} IS NOT NULL AND ${table.rangeEnd} IS NOT NULL)
  `),
]);
```

Postgres treats `NULL` as distinct in a unique index, so two `round_backfill` rows for the same feed+range would NOT collide if `quoteAssetAddress` is `NULL` on both (it is, by the type-shape check) — confirm this empirically in Step 4's test rather than assuming; if the dedup test fails because of NULL-distinctness, switch the unique index to a computed expression index on `coalesce(quote_asset_address, '')`/`coalesce(feed_address, '')`/`coalesce(range_start, -1)`/`coalesce(range_end, -1)` instead (Drizzle: define via `sql` in the index, or hand-adjust the generated migration — read what `db:generate` actually produces before deciding).

- [ ] **Step 2: Generate and apply**

Run: `cd be && npm run db:generate`, read the generated SQL (adjust per the Step 1 note if the unique index needs the `coalesce(...)` form), then apply to both dev and test DBs as in Task 1 Step 2.

- [ ] **Step 3: Write the failing tests**

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { claimDuePriceJobs, enqueueFeedResolutionJob, enqueueRoundBackfillJob, finishPriceJob } from './priceJobStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const quote = '0xjobquote000000000000000000000000000f01';
const feed = '0xjobfeed0000000000000000000000000000f02';

afterAll(async () => {
  await pool.query('DELETE FROM price_jobs WHERE quote_asset_address = $1 OR feed_address = $2', [quote, feed]);
  await pool.end();
});

describe('priceJobStore', () => {
  it('enqueues a feed-resolution job once, deduplicating repeated enqueue calls', async () => {
    await enqueueFeedResolutionJob(pool, 4663, quote);
    await enqueueFeedResolutionJob(pool, 4663, quote);
    const rows = await pool.query("SELECT count(*)::int AS count FROM price_jobs WHERE quote_asset_address = $1 AND job_type = 'feed_resolution'", [quote]);
    expect(rows.rows[0].count).toBe(1);
  });

  it('enqueues a round-backfill job once per exact (feed, range), two different ranges stay separate', async () => {
    await enqueueRoundBackfillJob(pool, 4663, feed, 1000, 2000);
    await enqueueRoundBackfillJob(pool, 4663, feed, 1000, 2000);
    await enqueueRoundBackfillJob(pool, 4663, feed, 2000, 3000);
    const rows = await pool.query("SELECT range_start, range_end FROM price_jobs WHERE feed_address = $1 AND job_type = 'round_backfill' ORDER BY range_start", [feed]);
    expect(rows.rows).toHaveLength(2);
  });

  it('claims due jobs with a lease and excludes them from a second concurrent claim', async () => {
    const now = new Date();
    const first = await claimDuePriceJobs(pool, now, 10, 60_000);
    expect(first.length).toBeGreaterThanOrEqual(2);
    const second = await claimDuePriceJobs(pool, now, 10, 60_000);
    expect(second).toHaveLength(0); // everything is leased until now+60s
  });

  it('finishPriceJob(ok: true) marks the job done; finishPriceJob(transport failure) retries with backoff', async () => {
    const now = new Date(Date.now() + 120_000); // past the lease above
    const [job] = await claimDuePriceJobs(pool, now, 1, 60_000);
    expect(job).toBeDefined();
    const saved = await finishPriceJob(pool, job, { ok: false, errorKind: 'transport', error: 'timeout' }, now);
    expect(saved).toBe(true);
    const row = await pool.query('SELECT status, attempts, next_attempt_at FROM price_jobs WHERE id = $1', [job.id]);
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].next_attempt_at).not.toBeNull();
  });

  it('finishPriceJob(rejected) marks the job permanently failed, never retried', async () => {
    const now = new Date(Date.now() + 240_000);
    const [job] = await claimDuePriceJobs(pool, now, 1, 60_000);
    expect(job).toBeDefined();
    await finishPriceJob(pool, job, { ok: false, errorKind: 'rejected', error: 'no trustworthy feed found' }, now);
    const row = await pool.query('SELECT status, next_attempt_at FROM price_jobs WHERE id = $1', [job.id]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].next_attempt_at).toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/market/quotePricing/priceJobStore.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

```typescript
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface PriceJob {
  id: string; jobType: 'feed_resolution' | 'round_backfill'; quoteAssetAddress: string | null;
  feedAddress: string | null; rangeStart: number | null; rangeEnd: number | null; attempts: number; leaseId: string;
}

export async function enqueueFeedResolutionJob(pool: Pool, chainId: number, quoteAssetAddress: string): Promise<void> {
  await pool.query(
    `INSERT INTO price_jobs (id, chain_id, job_type, quote_asset_address)
     VALUES ($1, $2, 'feed_resolution', $3)
     ON CONFLICT (chain_id, job_type, quote_asset_address, feed_address, range_start, range_end) DO NOTHING`,
    [randomUUID(), chainId, quoteAssetAddress.toLowerCase()],
  );
}

export async function enqueueRoundBackfillJob(pool: Pool, chainId: number, feedAddress: string, rangeStart: number, rangeEnd: number): Promise<void> {
  await pool.query(
    `INSERT INTO price_jobs (id, chain_id, job_type, feed_address, range_start, range_end)
     VALUES ($1, $2, 'round_backfill', $3, $4, $5)
     ON CONFLICT (chain_id, job_type, quote_asset_address, feed_address, range_start, range_end) DO NOTHING`,
    [randomUUID(), chainId, feedAddress.toLowerCase(), rangeStart, rangeEnd],
  );
}

export async function claimDuePriceJobs(pool: Pool, now: Date, limit: number, leaseMs: number): Promise<PriceJob[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id, job_type, quote_asset_address, feed_address, range_start, range_end, attempts FROM price_jobs
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         AND (lease_until IS NULL OR lease_until <= $1)
       ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    const claims: PriceJob[] = [];
    for (const row of due.rows as Record<string, unknown>[]) {
      const leaseId = randomUUID();
      await client.query('UPDATE price_jobs SET lease_id = $1, lease_until = $2 WHERE id = $3',
        [leaseId, new Date(now.getTime() + leaseMs), row.id]);
      claims.push({
        id: String(row.id), jobType: row.job_type as PriceJob['jobType'],
        quoteAssetAddress: row.quote_asset_address === null ? null : String(row.quote_asset_address),
        feedAddress: row.feed_address === null ? null : String(row.feed_address),
        rangeStart: row.range_start === null ? null : Number(row.range_start),
        rangeEnd: row.range_end === null ? null : Number(row.range_end),
        attempts: Number(row.attempts), leaseId,
      });
    }
    await client.query('COMMIT');
    return claims;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function nextPriceJobRetryAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(60 * 2 ** Math.min(attempts, 6), 3600) * 1000);
}

export async function finishPriceJob(
  pool: Pool, job: PriceJob, outcome: { ok: true } | { ok: false; errorKind: 'transport' | 'unknown' | 'rejected'; error: string }, now: Date,
): Promise<boolean> {
  if (outcome.ok) {
    const result = await pool.query(`UPDATE price_jobs SET status = 'done', lease_id = NULL, lease_until = NULL WHERE id = $1 AND lease_id = $2`,
      [job.id, job.leaseId]);
    return result.rowCount === 1;
  }
  if (outcome.errorKind === 'rejected') {
    const result = await pool.query(
      `UPDATE price_jobs SET status = 'failed', last_error = $1, next_attempt_at = NULL, lease_id = NULL, lease_until = NULL WHERE id = $2 AND lease_id = $3`,
      [outcome.error, job.id, job.leaseId]);
    return result.rowCount === 1;
  }
  const attempts = job.attempts + 1;
  const result = await pool.query(
    `UPDATE price_jobs SET attempts = $1, last_error = $2, next_attempt_at = $3, lease_id = NULL, lease_until = NULL WHERE id = $4 AND lease_id = $5`,
    [attempts, outcome.error, nextPriceJobRetryAt(now, attempts), job.id, job.leaseId]);
  return result.rowCount === 1;
}
```

- [ ] **Step 6: Run to verify they pass**

Run the Step 4 command. Expected: PASS, 5/5.

- [ ] **Step 7: Commit**

```bash
git add be/src/db/schema.ts be/drizzle/0023_*.sql be/drizzle/meta/0023_snapshot.json be/drizzle/meta/_journal.json be/src/market/quotePricing/priceJobStore.ts be/src/market/quotePricing/priceJobStore.integration.test.ts
git commit -m "feat: add price_jobs table and claim/finish/retry store for feed resolution and round backfill"
```

---

### Task 5: Feed discovery — Robinhood/Chainlink directory lookup, on-chain verification, aggregator resolution

**Files:**
- Create: `be/src/market/quotePricing/feedDiscovery.ts`
- Test: `be/src/market/quotePricing/feedDiscovery.test.ts`
- Modify: `be/src/market/quoteFeedRegistry.ts` (keep the two directory-fetch URLs and parsing; this task's `feedDiscovery.ts` imports and re-shapes them — do not duplicate the fetch/parse logic)

**Interfaces:**
- Consumes: `upsertQuoteFeed` (Task 1).
- Produces: `export interface DiscoveryClient { readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown> }`,
  `export async function discoverAndVerifyFeed(client: DiscoveryClient, lookupBySymbol: (address: string) => Promise<Address | null>, quoteAssetAddress: Address): Promise<{ feedAddress: Address; aggregatorAddress: Address } | null>` — `null` means no trustworthy feed was found (the caller marks the job `rejected`). Task 6 calls this inside the feed-resolution worker.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { discoverAndVerifyFeed } from './feedDiscovery.js';

const quote = '0xquote00000000000000000000000000000f001' as Address;
const candidateFeed = '0xcandidatefeed000000000000000000000f002' as Address;
const aggregator = '0xaggregator000000000000000000000000f003' as Address;

describe('discoverAndVerifyFeed', () => {
  it('verifies a candidate feed on-chain (decimals + a sane latestRoundData) and resolves its aggregator address', async () => {
    const lookupBySymbol = vi.fn(async () => candidateFeed);
    const client = { readContract: vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
      if (address.toLowerCase() === candidateFeed.toLowerCase()) {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') return [1n, 100_000_000n, 1n, 1_790_000_000n, 1n];
        if (functionName === 'aggregator') return aggregator;
      }
      throw new Error(`unexpected ${address} ${functionName}`);
    }) };
    const result = await discoverAndVerifyFeed(client, lookupBySymbol, quote);
    expect(result).toEqual({ feedAddress: candidateFeed, aggregatorAddress: aggregator });
  });

  it('returns null when the directory has no candidate for this address at all', async () => {
    const lookupBySymbol = vi.fn(async () => null);
    const client = { readContract: vi.fn() };
    expect(await discoverAndVerifyFeed(client, lookupBySymbol, quote)).toBeNull();
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('returns null (never a fabricated feed) when the candidate address does not behave like a real Chainlink feed on-chain', async () => {
    const lookupBySymbol = vi.fn(async () => candidateFeed);
    const client = { readContract: vi.fn(async () => { throw new Error('execution reverted'); }) };
    expect(await discoverAndVerifyFeed(client, lookupBySymbol, quote)).toBeNull();
  });

  it('returns null when latestRoundData reports a non-positive or clearly invalid answer', async () => {
    const lookupBySymbol = vi.fn(async () => candidateFeed);
    const client = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 0n, 1n, 1_790_000_000n, 1n];
      throw new Error(`unexpected ${functionName}`);
    }) };
    expect(await discoverAndVerifyFeed(client, lookupBySymbol, quote)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd be && npx vitest run src/market/quotePricing/feedDiscovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read `be/src/market/quoteFeedRegistry.ts`'s existing `createQuoteFeedRegistry` first — reuse its `resolve(address)` function (the Robinhood-asset-directory + Chainlink-feed-directory symbol-matching lookup) as the `lookupBySymbol` parameter at the call site in Task 6, rather than reimplementing directory parsing here. This file only adds the on-chain verification + aggregator-resolution step on top of whatever candidate address that lookup returns:

```typescript
import { parseAbi, type Address } from 'viem';

export interface DiscoveryClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function aggregator() view returns (address)',
]);

export async function discoverAndVerifyFeed(
  client: DiscoveryClient, lookupBySymbol: (address: string) => Promise<Address | null>, quoteAssetAddress: Address,
): Promise<{ feedAddress: Address; aggregatorAddress: Address } | null> {
  const candidate = await lookupBySymbol(quoteAssetAddress);
  if (!candidate) return null;
  try {
    const [decimalsResult, roundData, aggregatorAddress] = await Promise.all([
      client.readContract({ address: candidate, abi: aggregatorAbi, functionName: 'decimals' }),
      client.readContract({ address: candidate, abi: aggregatorAbi, functionName: 'latestRoundData' }),
      client.readContract({ address: candidate, abi: aggregatorAbi, functionName: 'aggregator' }),
    ]);
    if (typeof decimalsResult !== 'number' || !Number.isInteger(decimalsResult) || decimalsResult < 0 || decimalsResult > 255) return null;
    if (!Array.isArray(roundData) || typeof roundData[1] !== 'bigint' || roundData[1] <= 0n) return null;
    if (typeof aggregatorAddress !== 'string' || !aggregatorAddress.startsWith('0x')) return null;
    return { feedAddress: candidate, aggregatorAddress: aggregatorAddress as Address };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command. Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add be/src/market/quotePricing/feedDiscovery.ts be/src/market/quotePricing/feedDiscovery.test.ts
git commit -m "feat: verify a discovered quote feed on-chain and resolve its underlying aggregator"
```

---

### Task 6: Feed-resolution and round-backfill workers, periodic loop, Envio-sync enqueue hook

**Files:**
- Create: `be/src/market/quotePricing/roundBackfill.ts`
- Create: `be/src/market/quotePricing/priceEnrichment.ts`
- Test: `be/src/market/quotePricing/roundBackfill.test.ts`
- Test: `be/src/market/quotePricing/priceEnrichment.test.ts`
- Modify: `be/src/envioSync/runSync.ts`
- Modify: `be/src/envioSync/runSyncV2.ts`
- Modify: `be/src/cli/syncEnvioStagingLoop.ts`
- Test: `be/src/envioSync/runSync.integration.test.ts`
- Test: `be/src/envioSync/runSyncV2.integration.test.ts`

**Interfaces:**
- Consumes: `enqueueFeedResolutionJob`/`enqueueRoundBackfillJob`/`claimDuePriceJobs`/`finishPriceJob` (Task 4), `discoverAndVerifyFeed` (Task 5), `upsertPriceRounds` (Task 2), `upsertQuoteFeed` (Task 1).
- Produces: `export async function backfillRoundsForFeed(client: BackfillRpcClient, pool: Pool, chainId: number, aggregatorAddress: Address, rangeStart: number, rangeEnd: number): Promise<number>` — scans `AnswerUpdated` logs on the aggregator between the two unix-second bounds (translated to a block range first), decodes, persists via `upsertPriceRounds`, returns the count persisted.
  `export async function enrichPricesOnce(pool: Pool, client: DiscoveryClient & BackfillRpcClient, now: Date, limit?: number): Promise<{ claimed: number; done: number; pending: number }>`, `export function startPriceEnrichmentLoop(run: () => Promise<void>): { stop(): Promise<void> }` — mirrors `metadataEnrichment.ts`'s shape exactly.

- [ ] **Step 1: Write the failing round-backfill test**

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { backfillRoundsForFeed } from './roundBackfill.js';
import { findRoundAtOrBefore } from './priceRounds.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const aggregator = '0xbackfillaggregator00000000000000000f01';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [aggregator]);
  await pool.end();
});

// AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)
describe('backfillRoundsForFeed', () => {
  it('decodes real AnswerUpdated logs into rounds with their exact log position, and persists them', async () => {
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(blockNumber) * 10n }), // deterministic fake block time
      getLogs: async () => [{
        blockNumber: 500n, logIndex: 3, data: '0x', topics: [
          '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5', // AnswerUpdated topic0 (fixed, verified live this session)
          `0x${(300_000_000n).toString(16).padStart(64, '0')}`, // current (indexed int256)
          `0x${(7n).toString(16).padStart(64, '0')}`, // roundId (indexed uint256)
        ],
      }],
      decodeEventLog: undefined, // the implementation must decode itself; this test only needs the log shape above
    };
    const count = await backfillRoundsForFeed(client as never, pool, chainId, aggregator as never, 4000, 6000);
    expect(count).toBe(1);
    const round = await findRoundAtOrBefore(pool, chainId, aggregator, 500n, 3);
    expect(round?.roundId).toBe(7n);
    expect(round?.answerRaw).toBe(300_000_000n);
    expect(round?.blockNumber).toBe(500n);
    expect(round?.logIndex).toBe(3);
  });
});
```

Read `be/src/launchpads/pons/extendedMetadata.ts` and `be/src/chains/robinhood.ts` first for this project's real viem client/ABI-decoding conventions before writing `roundBackfill.ts`'s implementation — match the existing error-handling/decoding style (e.g. `decodeEventLog` from viem with a real `AnswerUpdated(int256,uint256,uint256)` ABI item, not manual hex slicing in production code; the test above shows raw log shape only because it's asserting the decode happens correctly end-to-end).

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/market/quotePricing/roundBackfill.integration.test.ts`
Expected: FAIL — module not found. (Rename to `.integration.test.ts` to match this project's convention, consistent with Tasks 1/2/4.)

- [ ] **Step 3: Implement `roundBackfill.ts`**

```typescript
import { decodeEventLog, parseAbiItem, type Address } from 'viem';
import type { Pool } from 'pg';
import { upsertPriceRounds } from './priceRounds.js';

export interface BackfillRpcClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getLogs(parameters: { address: Address; fromBlock: bigint; toBlock: bigint; topics: readonly [string] }): Promise<readonly {
    blockNumber: bigint; logIndex: number; data: `0x${string}`; topics: readonly `0x${string}`[];
  }[]>;
}

const answerUpdatedAbi = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)');

// Binary-searches block numbers for the two unix-second range bounds (viem has no "block at
// timestamp" RPC call; Chainlink chains don't guarantee one either) — bounded to O(log head) calls.
async function blockAtOrAfter(client: BackfillRpcClient, targetSeconds: number, head: bigint): Promise<bigint> {
  let low = 0n;
  let high = head;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < targetSeconds) low = mid + 1n; else high = mid;
  }
  return low;
}

export async function backfillRoundsForFeed(
  client: BackfillRpcClient, pool: Pool, chainId: number, aggregatorAddress: Address, rangeStart: number, rangeEnd: number,
): Promise<number> {
  const head = await client.getBlockNumber();
  const fromBlock = await blockAtOrAfter(client, rangeStart, head);
  const toBlock = rangeEnd >= Math.floor(Date.now() / 1000) ? head : await blockAtOrAfter(client, rangeEnd, head);
  const logs = await client.getLogs({ address: aggregatorAddress, fromBlock, toBlock, topics: [answerUpdatedAbi as unknown as string] });
  const rounds = logs.map((log) => {
    const decoded = decodeEventLog({ abi: [answerUpdatedAbi], data: log.data, topics: log.topics, strict: true });
    return {
      roundId: decoded.args.roundId, answerRaw: decoded.args.current < 0n ? 0n : decoded.args.current,
      decimals: 0, startedAt: Number(decoded.args.updatedAt), updatedAt: Number(decoded.args.updatedAt),
      blockNumber: log.blockNumber, logIndex: log.logIndex,
    };
  });
  return upsertPriceRounds(pool, chainId, aggregatorAddress, rounds);
}
```

(The `decimals: 0`/negative-answer-to-0 placeholders above are deliberately wrong and must be fixed before Step 4: `AnswerUpdated` does not carry the feed's `decimals()` — read it once per backfill call via a `decimals()` contract call on the feed/aggregator and apply it to every round in the batch; a genuinely negative Chainlink answer must be rejected (not clamped to 0) exactly like `usdPricing.ts`'s existing `fetchUsdPrice` does for `latestRoundData`. Write this correctly, then verify the test asserts the real `answerRaw`/`decimals` your corrected implementation produces — update the test's expectations to match real decimals handling before calling this step done.)

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command (adjusted for the `decimals()` fix above — add a `decimals: () => 8` style mock call to the test's `client` and assert the persisted round reflects it). Expected: PASS, 1/1.

- [ ] **Step 5: Write the failing enrichment-loop test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import * as priceJobStore from './priceJobStore.js';
import * as feedDiscovery from './feedDiscovery.js';
import * as feedRegistry from './feedRegistry.js';
import * as roundBackfill from './roundBackfill.js';
import { enrichPricesOnce } from './priceEnrichment.js';

vi.mock('./priceJobStore.js');
vi.mock('./feedDiscovery.js');
vi.mock('./feedRegistry.js');
vi.mock('./roundBackfill.js');

describe('enrichPricesOnce', () => {
  it('resolves a claimed feed-resolution job, persists the feed, and marks the job done', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j1', jobType: 'feed_resolution', quoteAssetAddress: '0xquote', feedAddress: null, rangeStart: null, rangeEnd: null, attempts: 0, leaseId: 'l1' },
    ]);
    vi.mocked(feedDiscovery.discoverAndVerifyFeed).mockResolvedValue({ feedAddress: '0xfeed' as never, aggregatorAddress: '0xagg' as never });
    const report = await enrichPricesOnce({} as never, {} as never, new Date());
    expect(feedRegistry.upsertQuoteFeed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ verificationStatus: 'verified', feedAddress: '0xfeed' }));
    expect(priceJobStore.finishPriceJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ok: true }, expect.anything());
    expect(report).toEqual({ claimed: 1, done: 1, pending: 0 });
  });

  it('marks a feed-resolution job rejected (not retried) when no trustworthy feed is found, and persists the rejection', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j2', jobType: 'feed_resolution', quoteAssetAddress: '0xquote2', feedAddress: null, rangeStart: null, rangeEnd: null, attempts: 0, leaseId: 'l2' },
    ]);
    vi.mocked(feedDiscovery.discoverAndVerifyFeed).mockResolvedValue(null);
    await enrichPricesOnce({} as never, {} as never, new Date());
    expect(feedRegistry.upsertQuoteFeed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ verificationStatus: 'rejected' }));
    expect(priceJobStore.finishPriceJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ok: false, errorKind: 'rejected', error: expect.any(String) }, expect.anything());
  });

  it('runs a round-backfill job and marks it done', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j3', jobType: 'round_backfill', quoteAssetAddress: null, feedAddress: '0xagg', rangeStart: 1000, rangeEnd: 2000, attempts: 0, leaseId: 'l3' },
    ]);
    vi.mocked(roundBackfill.backfillRoundsForFeed).mockResolvedValue(5);
    const report = await enrichPricesOnce({} as never, {} as never, new Date());
    expect(roundBackfill.backfillRoundsForFeed).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4663, '0xagg', 1000, 2000);
    expect(report.done).toBe(1);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd be && npx vitest run src/market/quotePricing/priceEnrichment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `priceEnrichment.ts`**

```typescript
import type { Pool } from 'pg';
import type { Address } from 'viem';
import { claimDuePriceJobs, finishPriceJob, type PriceJob } from './priceJobStore.js';
import { discoverAndVerifyFeed, type DiscoveryClient } from './feedDiscovery.js';
import { upsertQuoteFeed } from './feedRegistry.js';
import { backfillRoundsForFeed, type BackfillRpcClient } from './roundBackfill.js';

const CHAIN_ID = 4663;

export async function enrichPricesOnce(
  pool: Pool, client: DiscoveryClient & BackfillRpcClient, now: Date,
  lookupBySymbol: (address: string) => Promise<Address | null>, limit = 10,
): Promise<{ claimed: number; done: number; pending: number }> {
  const claims = await claimDuePriceJobs(pool, now, limit, 300_000);
  let done = 0;
  let pending = 0;
  for (const job of claims) {
    if (job.jobType === 'feed_resolution') {
      const result = await discoverAndVerifyFeed(client, lookupBySymbol, job.quoteAssetAddress as Address);
      if (result) {
        await upsertQuoteFeed(pool, { chainId: CHAIN_ID, quoteAssetAddress: job.quoteAssetAddress as Address,
          feedAddress: result.feedAddress, aggregatorAddress: result.aggregatorAddress, discoverySource: 'directory', verificationStatus: 'verified', now });
        await finishPriceJob(pool, job, { ok: true }, now);
        done++;
      } else {
        await upsertQuoteFeed(pool, { chainId: CHAIN_ID, quoteAssetAddress: job.quoteAssetAddress as Address,
          feedAddress: '0x0000000000000000000000000000000000dead' as Address, aggregatorAddress: null, discoverySource: 'directory', verificationStatus: 'rejected', now });
        await finishPriceJob(pool, job, { ok: false, errorKind: 'rejected', error: 'no trustworthy feed found' }, now);
        pending++;
      }
    } else {
      try {
        await backfillRoundsForFeed(client, pool, CHAIN_ID, job.feedAddress as Address, job.rangeStart!, job.rangeEnd!);
        await finishPriceJob(pool, job, { ok: true }, now);
        done++;
      } catch (error) {
        await finishPriceJob(pool, job, { ok: false, errorKind: 'transport', error: (error as Error).message }, now);
        pending++;
      }
    }
  }
  return { claimed: claims.length, done, pending };
}

export function startPriceEnrichmentLoop(run: () => Promise<void>): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve().then(run).catch(() => { /* caller wraps run() in its own try/catch */ }).finally(() => { active = null; });
  };
  const interval = setInterval(tick, 60_000);
  tick();
  return { async stop() { stopped = true; clearInterval(interval); if (active) await active; } };
}
```

Fix the `upsertQuoteFeed` "rejected" branch's placeholder `feedAddress: '0x000...dead'` before calling this done — `upsertQuoteFeed`'s type requires a non-null `feedAddress` even for a rejected row; either relax that type to accept `feedAddress: null` for a rejection (preferred — re-check Task 1's `upsertQuoteFeed` signature and widen it there if needed, then update Task 1's own test for the `rejected` case to assert `feedAddress: null`) or keep a sentinel value and document why. Pick the first option; a sentinel "dead" address being silently read back as if it were real is exactly the kind of fabricated-looking value this project's conventions reject.

- [ ] **Step 8: Run to verify it passes**

Run the Step 6 command. Expected: PASS, 3/3.

- [ ] **Step 9: Wire the enqueue-on-new-quote-asset hook into both Envio sync paths**

In `be/src/envioSync/runSync.ts`, find the `tx.insert(launches).values({...})` block (~line 115, inside `syncV1LegacyToReal`) and the `tx.insert(trades).values({...})` block (~line 151). After a successful launch insert, call `await enqueueFeedResolutionJob(pool, launch.chainId, launch.quoteAsset.address)` where `pool` is the raw `pg.Pool` this function already has access to (check the exact parameter name `syncV1LegacyToReal` receives it under before writing this — it may be a different local name than `pool`). Do the same in `be/src/envioSync/runSyncV2.ts`'s `syncV2ToReal`'s launch insert (~line 221). Import `enqueueFeedResolutionJob` from `../market/quotePricing/priceJobStore.js`.

Add one integration test per file (mirroring the existing fixture-insertion style already in `runSync.integration.test.ts`/`runSyncV2.integration.test.ts`): insert a launch whose quote-asset address has never been seen before, run the real sync function, then assert a `price_jobs` row with `job_type = 'feed_resolution'` and that exact `quote_asset_address` now exists. Run both integration test files; expect the new tests to fail first (no enqueue call exists yet), then pass after the wiring.

- [ ] **Step 10: Start the loop from the sync CLI**

In `be/src/cli/syncEnvioStagingLoop.ts`, alongside the existing `startMetadataEnrichmentLoop` wiring, start `startPriceEnrichmentLoop(() => enrichPricesOnce(pool, rpcClient, new Date(), quoteFeedRegistry.resolve))` the same way (read the file first to match its exact existing pattern for constructing `rpcClient`/`pool` and stopping loops on `SIGTERM`).

- [ ] **Step 11: Run the full backend suite, typecheck, lint**

Run: `cd be && npm test && npx tsc --noEmit && npm run lint && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`
Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add be/src/market/quotePricing/roundBackfill.ts be/src/market/quotePricing/roundBackfill.integration.test.ts be/src/market/quotePricing/priceEnrichment.ts be/src/market/quotePricing/priceEnrichment.test.ts be/src/market/quotePricing/feedRegistry.ts be/src/market/quotePricing/feedRegistry.integration.test.ts be/src/envioSync/runSync.ts be/src/envioSync/runSync.integration.test.ts be/src/envioSync/runSyncV2.ts be/src/envioSync/runSyncV2.integration.test.ts be/src/cli/syncEnvioStagingLoop.ts
git commit -m "feat: run feed-resolution and round-backfill as a periodic background job loop"
```

---

### Task 7: Signed volume cursor

**Files:**
- Create: `be/src/api/volumeCursor.ts`
- Test: `be/src/api/volumeCursor.test.ts`
- Modify: `be/.env.example`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export interface VolumeCursorValue { version: 1; sort: 'volume24hUsd'; asOf: number; rankCategory: 'positive' | 'zero' | 'null'; rankValue: string | null; tiebreakBlockNumber: string; tiebreakTxHash: string; tiebreakLogIndex: number }`,
  `export function encodeVolumeCursor(value: VolumeCursorValue, secret: string): string`, `export function decodeVolumeCursor(value: string, secret: string, now: number): VolumeCursorValue` (throws `Error('Invalid cursor')` on any tamper/expiry/shape failure, mirroring `be/src/api/cursor.ts`'s existing throw convention). Task 9 uses both.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { decodeVolumeCursor, encodeVolumeCursor, type VolumeCursorValue } from './volumeCursor.js';

const secret = 'test-secret-do-not-use-in-production';
const value: VolumeCursorValue = { version: 1, sort: 'volume24hUsd', asOf: 1_790_000_000, rankCategory: 'positive',
  rankValue: '1234.56', tiebreakBlockNumber: '100', tiebreakTxHash: '0x' + 'a'.repeat(64), tiebreakLogIndex: 3 };

describe('volumeCursor', () => {
  it('round-trips a value', () => {
    const encoded = encodeVolumeCursor(value, secret);
    expect(decodeVolumeCursor(encoded, secret, 1_790_000_100)).toEqual(value);
  });

  it('rejects a cursor signed with a different secret (tamper detection)', () => {
    const encoded = encodeVolumeCursor(value, secret);
    expect(() => decodeVolumeCursor(encoded, 'wrong-secret', 1_790_000_100)).toThrow('Invalid cursor');
  });

  it('rejects a cursor whose payload was edited after signing', () => {
    const encoded = encodeVolumeCursor(value, secret);
    const [payload, signature] = encoded.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...value, rankValue: '999999.99' })).toString('base64url') + '.' + signature;
    expect(() => decodeVolumeCursor(tampered, secret, 1_790_000_100)).toThrow('Invalid cursor');
    void payload;
  });

  it('rejects a cursor older than a bounded age', () => {
    const encoded = encodeVolumeCursor(value, secret);
    expect(() => decodeVolumeCursor(encoded, secret, value.asOf + 25 * 3600)).toThrow('Invalid cursor');
  });

  it('rejects malformed input instead of throwing an unrelated error', () => {
    expect(() => decodeVolumeCursor('not-a-real-cursor', secret, 1_790_000_100)).toThrow('Invalid cursor');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd be && npx vitest run src/api/volumeCursor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VolumeCursorValue {
  version: 1; sort: 'volume24hUsd'; asOf: number; rankCategory: 'positive' | 'zero' | 'null';
  rankValue: string | null; tiebreakBlockNumber: string; tiebreakTxHash: string; tiebreakLogIndex: number;
}

const MAX_CURSOR_AGE_SECONDS = 24 * 3600;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeVolumeCursor(value: VolumeCursorValue, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeVolumeCursor(value: string, secret: string, now: number): VolumeCursorValue {
  try {
    const [payload, signature] = value.split('.');
    if (!payload || !signature) throw new Error('Invalid cursor');
    const expected = sign(payload, secret);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid cursor');
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid cursor');
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || candidate.sort !== 'volume24hUsd') throw new Error('Invalid cursor');
    if (typeof candidate.asOf !== 'number' || !Number.isSafeInteger(candidate.asOf)) throw new Error('Invalid cursor');
    if (now - candidate.asOf > MAX_CURSOR_AGE_SECONDS) throw new Error('Invalid cursor');
    if (candidate.rankCategory !== 'positive' && candidate.rankCategory !== 'zero' && candidate.rankCategory !== 'null') throw new Error('Invalid cursor');
    if (typeof candidate.tiebreakBlockNumber !== 'string' || typeof candidate.tiebreakTxHash !== 'string' || typeof candidate.tiebreakLogIndex !== 'number') {
      throw new Error('Invalid cursor');
    }
    return candidate as unknown as VolumeCursorValue;
  } catch {
    throw new Error('Invalid cursor');
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command. Expected: PASS, 5/5.

- [ ] **Step 5: Add the required env var**

In `be/.env.example`, add a line `VOLUME_CURSOR_SECRET=` with a comment that it must be set to a long random string before enabling `sort=volume24hUsd`, and document the same in `be/.env` (not committed — add it to your own local file).

- [ ] **Step 6: Commit**

```bash
git add be/src/api/volumeCursor.ts be/src/api/volumeCursor.test.ts be/.env.example
git commit -m "feat: add a signed, versioned cursor for the volume24hUsd sort"
```

---

### Task 8: Synthetic-scale benchmark data generator

**Files:**
- Create: `be/src/cli/generateSyntheticTrades.ts`
- Test: `be/src/cli/generateSyntheticTrades.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export function buildSyntheticTradeBatch(params: { chainId: number; tokenAddress: string; venueId: string; quoteAssetAddress: string; startBlock: bigint; count: number; startTimestamp: number }): readonly SyntheticTrade[]` — a pure, testable row-builder; the CLI wraps it with real bulk inserts. Task 9's benchmark step runs this CLI.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { buildSyntheticTradeBatch } from './generateSyntheticTrades.js';

describe('buildSyntheticTradeBatch', () => {
  it('builds the requested count of rows with strictly increasing (blockNumber, logIndex) and timestamp', () => {
    const rows = buildSyntheticTradeBatch({ chainId: 4663, tokenAddress: '0xabc', venueId: 'v1', quoteAssetAddress: '0xquote',
      startBlock: 100n, count: 5, startTimestamp: 1_700_000_000 });
    expect(rows).toHaveLength(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].blockNumber > rows[i - 1].blockNumber
        || (rows[i].blockNumber === rows[i - 1].blockNumber && rows[i].logIndex > rows[i - 1].logIndex)).toBe(true);
      expect(rows[i].timestamp).toBeGreaterThanOrEqual(rows[i - 1].timestamp);
    }
  });

  it('gives every row a unique txHash so the (chainId, txHash, logIndex) primary key never collides', () => {
    const rows = buildSyntheticTradeBatch({ chainId: 4663, tokenAddress: '0xabc', venueId: 'v1', quoteAssetAddress: '0xquote',
      startBlock: 100n, count: 1000, startTimestamp: 1_700_000_000 });
    expect(new Set(rows.map((row) => row.txHash)).size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && npx vitest run src/cli/generateSyntheticTrades.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
export interface SyntheticTrade {
  chainId: number; tokenAddress: string; venueId: string; quoteAssetAddress: string;
  blockNumber: bigint; blockHash: string; txHash: string; logIndex: number; timestamp: number;
  side: 'buy' | 'sell'; tokenAmountRaw: string; quoteAmountRaw: string;
}

export function buildSyntheticTradeBatch(params: {
  chainId: number; tokenAddress: string; venueId: string; quoteAssetAddress: string;
  startBlock: bigint; count: number; startTimestamp: number;
}): readonly SyntheticTrade[] {
  const rows: SyntheticTrade[] = [];
  for (let i = 0; i < params.count; i++) {
    const blockNumber = params.startBlock + BigInt(i);
    const hex = blockNumber.toString(16).padStart(8, '0') + i.toString(16).padStart(8, '0');
    rows.push({
      chainId: params.chainId, tokenAddress: params.tokenAddress, venueId: params.venueId, quoteAssetAddress: params.quoteAssetAddress,
      blockNumber, blockHash: `0x${hex.padStart(64, '0')}`, txHash: `0x${hex.padStart(64, '1')}`, logIndex: 0,
      timestamp: params.startTimestamp + i, side: i % 2 === 0 ? 'buy' : 'sell',
      tokenAmountRaw: (1_000_000_000_000_000_000n + BigInt(i)).toString(), quoteAmountRaw: (10_000_000_000_000_000n + BigInt(i)).toString(),
    });
  }
  return rows;
}
```

Then write the CLI wrapper (`be/src/cli/generateSyntheticTrades.ts`'s executable part, below the exported pure function) that: takes `--launches` and `--tradesPerLaunch` CLI args (or hardcoded constants — document which), creates that many synthetic `sources`/`launches`/`venues` rows plus `tradesPerLaunch` synthetic `trades` rows per launch spread realistically across the last 30 days, using `be/src/db/chunk.ts`'s successor pattern — **`chunk.ts` was deleted with the old indexer** (Task 5 of the previous plan), so re-implement a minimal local chunking helper here (bulk INSERT respecting Postgres's 65,535-bind-parameter limit — same root cause CLAUDE.md already documents) rather than reviving the deleted file; do not import anything from the deleted RPC-scan indexer. Target: enough rows that Task 9's benchmark query runs against a `trades` table of **at least 5 million rows** (CLAUDE.md records the real production `trades` table around 3.2M rows — use a somewhat larger synthetic figure so the benchmark result is not optimistic).

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command. Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add be/src/cli/generateSyntheticTrades.ts be/src/cli/generateSyntheticTrades.test.ts
git commit -m "feat: add a synthetic-scale trade data generator for the volume-ranking benchmark"
```

---

### Task 9: Global `volume24hUsd` ranking query, signed cursor wiring, API fields

**Files:**
- Modify: `be/src/api/store.ts`
- Modify: `be/src/api/server.ts`
- Modify: `be/src/api/schemas.ts`
- Modify: `be/src/api/routes/launches.ts`
- Test: `be/src/api/store.integration.test.ts`

**Interfaces:**
- Consumes: `valueTradeUsd` (Task 3), `encodeVolumeCursor`/`decodeVolumeCursor` (Task 7).
- Produces: `LaunchListQuery` gains `sort?: 'volume24hUsd' | 'recent'`; `LaunchSummary` gains `officialVolume24hUsd: string | null; officialVolume24hUsdApprox: boolean`.

- [ ] **Step 1: Write the failing integration tests**

In `be/src/api/store.integration.test.ts`, add a new `describe` block seeding 3 launches with distinct, known official trades and quote-asset feeds/rounds (reuse the existing `goodToken`-style fixture pattern already in this file — insert real rows into `quote_usd_feeds` and `quote_usd_price_rounds` for a test quote address, matching Task 1-3's exact column names):

```typescript
describe('listLaunches sort=volume24hUsd (global ranking)', () => {
  // Seed launches A (volume $300), B (volume $100), C (zero trades, complete coverage), D (one trade with no backfilled round yet).
  // Full fixture setup mirrors the existing goodToken pattern in this file: insert sources/launches/venues rows,
  // insert a verified quote_usd_feeds row and matching quote_usd_price_rounds rows for the shared test quote asset,
  // insert trades with known quote_amount_raw and (block_number, log_index) positions.

  it('ranks launches by real USD volume descending, not by raw quote-unit amounts across different quote assets', async () => {
    const page = await store.listLaunches({ limit: 10, chainId: 4663, sort: 'volume24hUsd' });
    const ranked = page.items.filter((item) => ['A', 'B', 'C', 'D'].includes(item.name));
    expect(ranked.map((item) => item.name)).toEqual(['A', 'B', 'C', 'D']); // positive desc, then zero, then null
  });

  it('gives a known zero-trade launch with complete coverage a real "0", never null', async () => {
    const page = await store.listLaunches({ limit: 10, chainId: 4663, sort: 'volume24hUsd' });
    const zero = page.items.find((item) => item.name === 'C');
    expect(zero?.officialVolume24hUsd).toBe('0');
  });

  it('gives a launch with a positive trade but a missing historical round a null rank, never an understated partial sum', async () => {
    const page = await store.listLaunches({ limit: 10, chainId: 4663, sort: 'volume24hUsd' });
    const partial = page.items.find((item) => item.name === 'D');
    expect(partial?.officialVolume24hUsd).toBeNull();
  });

  it('paginates with a signed cursor distinct from the recency cursor, and rejects a cursor used with the wrong sort', async () => {
    const first = await store.listLaunches({ limit: 1, chainId: 4663, sort: 'volume24hUsd' });
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listLaunches({ limit: 1, chainId: 4663, sort: 'volume24hUsd', cursor: first.nextCursor! });
    expect(second.items[0]?.name).not.toBe(first.items[0]?.name);
    await expect(store.listLaunches({ limit: 1, chainId: 4663, sort: 'recent', cursor: first.nextCursor! })).rejects.toThrow();
  });

  it('keeps sort=recent (default) byte-for-byte unaffected — same order and cursor shape as before this change', async () => {
    const page = await store.listLaunches({ limit: 50, chainId: 4663 });
    expect(page.items[0]?.tokenAddress).toBeDefined(); // existing recency-order tests elsewhere in this file already pin the exact order; this just confirms the omitted-sort path still works post-change
  });
});
```

Read the rest of `store.integration.test.ts`'s existing fixtures first and write the real `beforeAll`/seed SQL for launches A–D with exact quote amounts and round prices that produce the $300/$100/$0/null outcomes asserted above — the plan intentionally doesn't hand-write that SQL here since it must match this file's real existing `source`/`launches`/`venues` column list exactly (already captured in Tasks 1 and prior sessions' edits to this same file); copy the pattern, don't guess it.

- [ ] **Step 2: Run to verify they fail**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/api/store.integration.test.ts`
Expected: FAIL — `sort` is not a recognized query field yet / `officialVolume24hUsd` is `undefined`.

- [ ] **Step 3: Add `sort` to `LaunchListQuery` and the two new fields to `LaunchSummary`**

In `be/src/api/server.ts`: `export interface LaunchListQuery extends ListQuery { search?: string; status?: string; platform?: string; sort?: 'volume24hUsd' | 'recent' }`; add `officialVolume24hUsd: string | null; officialVolume24hUsdApprox: boolean;` to `LaunchSummary`.

In `be/src/api/routes/launches.ts`'s `launchListQuery`, parse `value.sort`: accept only `'volume24hUsd'` or `'recent'` (or undefined, defaulting to `'recent'` per the spec's "keep the API's omitted-sort behavior as recent"); return `null` (→ 400) for anything else.

In `be/src/api/schemas.ts`, add `officialVolume24hUsd: { type: 'string', nullable: true }, officialVolume24hUsdApprox: { type: 'boolean' }` to `launchSummary`.

- [ ] **Step 4: Implement the ranking query in `store.ts`**

This is the core of the task — the full implementation, not a sketch. In `createApiStore`, add this function (it needs `pool`, `rpcClient`, `computeStats`, `summary`, `NULL_STATS` from the enclosing closure, same as every other function already in this file):

```typescript
async function listLaunchesByVolume(query: LaunchListQuery): Promise<Page<LaunchSummary>> {
  const secret = process.env.VOLUME_CURSOR_SECRET;
  if (!secret) throw new Error('VOLUME_CURSOR_SECRET is required to use sort=volume24hUsd');
  const head = await safeHead();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cursorValue = query.cursor ? decodeVolumeCursor(query.cursor, secret, nowSeconds) : null;
  const asOf = cursorValue?.asOf ?? nowSeconds;
  const since = asOf - 86_400;

  // Base set: every launch matching the filters, with its coverage-complete flag (reuses the
  // existing per-launch coverage rule used by the recency path — same semantics, just no pagination
  // predicate here, since the final order depends on volume, not launch position).
  const baseResult = await pool.query(`
    SELECT l.*, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
      ${launchCoverageSql(5)} AS launch_coverage_complete
    FROM launches l JOIN sources s ON s.id = l.source_id
    WHERE ($1::integer IS NULL OR l.chain_id = $1) AND ($2::text IS NULL OR l.platform = $2)
      AND ($3::text IS NULL OR l.lifecycle_status = $3)
      AND ($4::text IS NULL OR l.name ILIKE '%' || $4 || '%' OR l.symbol ILIKE '%' || $4 || '%')
  `, [query.chainId ?? null, query.platform ?? null, query.status ?? null, query.search ?? null, head?.toString() ?? null]);
  const launchRows = baseResult.rows as Row[];

  // Per-trade historical USD valuation for every official trade of every matching launch in the
  // window — one LATERAL join against quote_usd_price_rounds, deliberately mirroring
  // tradeValuation.ts's valueTradeUsd selection logic exactly (round at or before the trade's own
  // (blockNumber, logIndex), rejected if stale) so the two never disagree. If this ever needs to
  // change, change valueTradeUsd's math and this query in the same commit.
  const tradesResult = await pool.query(`
    SELECT l.chain_id, l.token_address, l.quote_asset_decimals, t.quote_amount_raw, t.block_number, t.log_index, t.timestamp,
      f.feed_address, r.answer_raw, r.decimals AS price_decimals, r.updated_at AS price_updated_at
    FROM launches l
    JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
    JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
      AND t.timestamp >= $1 AND t.timestamp <= $2
    LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address AND f.verification_status = 'verified'
    LEFT JOIN LATERAL (
      SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
      WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
      ORDER BY block_number DESC, log_index DESC LIMIT 1
    ) r ON true
    WHERE ($3::integer IS NULL OR l.chain_id = $3) AND ($4::text IS NULL OR l.platform = $4)
      AND ($5::text IS NULL OR l.lifecycle_status = $5) AND ($6::text IS NULL OR l.name ILIKE '%' || $6 || '%' OR l.symbol ILIKE '%' || $6 || '%')
  `, [since, asOf, query.chainId ?? null, query.platform ?? null, query.status ?? null, query.search ?? null]);

  interface VolumeAgg { usdTotal: number; hasUnpriced: boolean; hasTrades: boolean }
  const byLaunch = new Map<string, VolumeAgg>();
  for (const row of tradesResult.rows as Row[]) {
    const key = `${number(row.chain_id)}:${string(row.token_address)}`;
    const agg = byLaunch.get(key) ?? { usdTotal: 0, hasUnpriced: false, hasTrades: false };
    agg.hasTrades = true;
    if (row.feed_address === null || row.answer_raw === null) {
      agg.hasUnpriced = true;
    } else {
      const ageSeconds = number(row.timestamp) - number(row.price_updated_at);
      if (ageSeconds < 0 || ageSeconds > 86_400) {
        agg.hasUnpriced = true;
      } else {
        const quoteAmount = Number(formatUnits(BigInt(string(row.quote_amount_raw)), number(row.quote_asset_decimals)));
        const priceUsd = Number(string(row.answer_raw)) / 10 ** number(row.price_decimals);
        agg.usdTotal += quoteAmount * priceUsd;
      }
    }
    byLaunch.set(key, agg);
  }

  interface RankedLaunch { row: Row; complete: boolean; usd: string | null; approx: boolean }
  function rankCategory(usd: string | null): 'positive' | 'zero' | 'null' {
    return usd === null ? 'null' : Number(usd) > 0 ? 'positive' : 'zero';
  }
  const categoryOrder = { positive: 0, zero: 1, null: 2 } as const;

  const ranked: RankedLaunch[] = launchRows.map((row) => {
    const complete = Boolean(row.launch_coverage_complete);
    const agg = byLaunch.get(`${number(row.chain_id)}:${string(row.token_address)}`);
    if (!complete) return { row, complete, usd: null, approx: false };
    if (!agg || !agg.hasTrades) return { row, complete, usd: '0', approx: false };
    if (agg.hasUnpriced) return { row, complete, usd: null, approx: false };
    return { row, complete, usd: agg.usdTotal.toString(), approx: true };
  });

  ranked.sort((a, b) => {
    const catA = rankCategory(a.usd);
    const catB = rankCategory(b.usd);
    if (categoryOrder[catA] !== categoryOrder[catB]) return categoryOrder[catA] - categoryOrder[catB];
    if (catA === 'positive') {
      const diff = Number(b.usd) - Number(a.usd);
      if (diff !== 0) return diff;
    }
    const blockA = BigInt(string(a.row.block_number));
    const blockB = BigInt(string(b.row.block_number));
    if (blockA !== blockB) return blockA > blockB ? -1 : 1;
    const txCompare = string(b.row.tx_hash).localeCompare(string(a.row.tx_hash));
    if (txCompare !== 0) return txCompare;
    return number(b.row.log_index) - number(a.row.log_index);
  });

  let startIndex = 0;
  if (cursorValue) {
    const pinnedIndex = ranked.findIndex((item) =>
      rankCategory(item.usd) === cursorValue.rankCategory && (item.usd ?? null) === cursorValue.rankValue
      && string(item.row.block_number) === cursorValue.tiebreakBlockNumber && string(item.row.tx_hash) === cursorValue.tiebreakTxHash
      && number(item.row.log_index) === cursorValue.tiebreakLogIndex);
    // The pinned row vanished (reorg, or a backfill changed its category) — fail closed rather than
    // silently restarting from page 1, which would look like a correct response but isn't.
    if (pinnedIndex === -1) throw new Error('Invalid cursor');
    startIndex = pinnedIndex + 1;
  }
  const slice = ranked.slice(startIndex, startIndex + query.limit + 1);
  const included = slice.slice(0, query.limit);
  const last = included.at(-1);
  const nextCursor = slice.length > query.limit && last
    ? encodeVolumeCursor({ version: 1, sort: 'volume24hUsd', asOf, rankCategory: rankCategory(last.usd), rankValue: last.usd,
      tiebreakBlockNumber: string(last.row.block_number), tiebreakTxHash: string(last.row.tx_hash), tiebreakLogIndex: number(last.row.log_index) }, secret)
    : null;

  const statsByToken = new Map(await Promise.all(included.map(async (item) =>
    [string(item.row.token_address), await computeStats(pool, rpcClient, item.row, item.complete)] as const)));
  return {
    items: included.map((item) => ({
      ...summary(item.row, item.complete, statsByToken.get(string(item.row.token_address)) ?? NULL_STATS),
      officialVolume24hUsd: item.usd, officialVolume24hUsdApprox: item.approx,
    })),
    nextCursor,
  };
}
```

This fetches every matching launch plus every matching trade into Node and ranks in memory — deliberately the "read-side aggregate" the spec asks to try first. It is also exactly the design Task 11 exists to benchmark; if `baseResult`'s full-table scan (166K+ launches, per CLAUDE.md) or `tradesResult`'s global 24h scan turns out to dominate, Task 11's `EXPLAIN ANALYZE` output will point at one of these two queries specifically.

- [ ] **Step 4a: Wire `sort=recent`'s non-USD fields to omit `officialVolume24hUsd`/`officialVolume24hUsdApprox` consistently**

The existing recency-path `summary()` call doesn't set `officialVolume24hUsd`/`officialVolume24hUsdApprox` at all yet. Add them there too — `officialVolume24hUsd: null, officialVolume24hUsdApprox: false` unconditionally on the recency path (the spec doesn't ask for USD volume on `sort=recent`; staying honestly `null` there, rather than computing it unnecessarily on every recency-sorted page, keeps that path's existing performance characteristics unchanged — a launch's `sort=recent` row and `sort=volume24hUsd` row will show different values for this field by design, which is expected and should be tested).

This step's own "Expected" is necessarily the full Step 2 integration-test run passing — there is no smaller intermediate check for a query this shaped. Run the Step 2 command, and iterate on the real SQL/TS above until all 5 new tests plus every pre-existing test in the file pass. Budget real time for this step; it is the plan's hardest.

- [ ] **Step 5: Wire `sort` into `listLaunches`'s existing dispatch and keep `recent` byte-identical**

```typescript
async listLaunches(query: LaunchListQuery) {
  if (query.sort === 'volume24hUsd') return listLaunchesByVolume(query, await safeHead());
  // ...the existing recency-sort implementation, completely unchanged...
}
```

- [ ] **Step 6: Run to verify the integration tests pass**

Run the Step 2 command. Expected: PASS, all new tests plus every pre-existing test in the file (confirms `sort=recent`/omitted-sort is untouched).

- [ ] **Step 7: Run backend typecheck, lint, openapi regen**

Run: `cd be && npx tsc --noEmit && npm run lint && npm run openapi:write && cd ../fe && npm run generate:schema && cd ../be && npm run openapi:check`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add be/src/api/store.ts be/src/api/server.ts be/src/api/schemas.ts be/src/api/routes/launches.ts be/src/api/store.integration.test.ts be/openapi.json fe/src/api/schema.ts
git commit -m "feat: add global sort=volume24hUsd ranking with a signed cursor"
```

---

### Task 10: `/trades` — historical valuation, `usdValueStatus`, demand-driven backfill enqueue

**Files:**
- Modify: `be/src/api/store.ts` (`listTrades`)
- Modify: `be/src/api/server.ts` (`TradeResponse`)
- Modify: `be/src/api/schemas.ts` (`trade`)
- Test: `be/src/api/store.integration.test.ts`

**Interfaces:**
- Consumes: `valueTradeUsd` (Task 3), `enqueueRoundBackfillJob` (Task 4).
- Produces: `TradeResponse` gains `usdValueStatus: 'priced' | 'pending' | 'unavailable'`; removes the current-price fallback entirely.

- [ ] **Step 1: Write the failing tests**

Add to `store.integration.test.ts`'s existing trade-USD-value `describe` block:

```typescript
it('values a trade at its own historical quote price, never the current/latest price, and never changes when the latest price moves', async () => {
  // Seed a verified feed + an old round far from "now"'s real market price; assert usdValue matches
  // the OLD round's price, not whatever readUsdPrice's live latestRoundData mock would have returned.
});

it('returns usdValueStatus: pending (not a silently-approximated value) and enqueues a round-backfill job when the historical round is missing', async () => {
  // Seed a verified feed with NO rounds at all; assert usdValue is null, usdValueStatus is 'pending',
  // and a price_jobs round_backfill row now exists for that feed covering a range including the trade's timestamp.
});

it('returns usdValueStatus: unavailable when there is no verified feed for the quote asset at all', async () => {
  // No quote_usd_feeds row; assert usdValue null, usdValueStatus 'unavailable', and NO price_jobs
  // round_backfill row is created (there's nothing to backfill without a feed) — a feed_resolution
  // job may already exist from the sync-path hook in Task 6, that's fine and expected, assert on
  // round_backfill specifically.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/api/store.integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `listTrades`'s USD-valuation block**

Remove the current `rpcClient && rows[0] ? await readUsdPrice(...)` block entirely. Replace the per-row mapping with:

```typescript
async listTrades(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TradeResponse>> {
  // ...unchanged cursor/query logic through fetching `rows`...
  // Every row on one launch's trade page shares the same quote asset, so this calls
  // resolveVerifiedFeed (inside valueTradeUsd) once per row redundantly — bounded by query.limit
  // (≤100), acceptable for now; if it shows up in Task 11's benchmark, resolve the feed once above
  // this loop and thread it into a valueTradeUsd overload that accepts a pre-resolved feed instead.
  const valuations = await Promise.all(rows.map((row) => valueTradeUsd(pool, chainId, string(row.launch_quote_asset_address), {
    timestamp: number(row.timestamp), quoteAmountRaw: BigInt(string(row.quote_amount_raw)),
    quoteAssetDecimals: number(row.quote_asset_decimals), blockNumber: BigInt(string(row.block_number)), logIndex: number(row.log_index),
  })));
  // Demand-driven backfill: a `pending` row means a verified feed exists but this trade's exact
  // round isn't backfilled — enqueue ONE bounded, deduplicated job covering a window around this
  // trade's timestamp (enqueueRoundBackfillJob already dedupes on the exact range, so repeated page
  // loads for the same old trades don't pile up jobs). Never do this synchronously inside the loop
  // above the request — fire-and-forget after the response data is already computed.
  const feed = await resolveVerifiedFeed(pool, chainId, string(rows[0]?.launch_quote_asset_address ?? ''));
  if (feed) {
    for (const [i, valuation] of valuations.entries()) {
      if (valuation.status === 'pending') {
        const t = number(rows[i].timestamp);
        void enqueueRoundBackfillJob(pool, chainId, feed.feedAddress, t - 3600, t + 3600).catch(() => {});
      }
    }
  }
  return page(rows, query.limit, (row, i) => ({
    venueId: string(row.venue_id), blockNumber: string(row.block_number), txHash: string(row.tx_hash),
    logIndex: number(row.log_index), timestamp: number(row.timestamp), side: string(row.side),
    activityKind: string(row.activity_kind), tokenAmount: formatUnits(BigInt(string(row.token_amount_raw)), number(row.token_decimals)),
    quoteAmount: formatUnits(BigInt(string(row.quote_amount_raw)), number(row.quote_asset_decimals)),
    priceQuote: row.price_numerator_raw === null || row.price_denominator_raw === null ? null
      : formatRational(BigInt(string(row.price_numerator_raw)), BigInt(string(row.price_denominator_raw)), 18),
    traderAddress: string(row.trader_address),
    usdValue: valuations[i].status === 'priced' ? (valuations[i] as { status: 'priced'; usdValue: string }).usdValue : null,
    usdValueApprox: valuations[i].status === 'priced',
    usdValueStatus: valuations[i].status,
  })) as Page<TradeResponse>;
}
```

`page()`'s current `map` signature only takes `(row: Row) => T`; widen it to `(row: Row, index: number) => T` in `be/src/api/store.ts`'s `page` helper (Step 3a) since this is the first caller needing the row's index — check every other existing call site of `page()` in this file still compiles unchanged (they ignore the new second parameter, which is backward-compatible).

- [ ] **Step 4: Add `usdValueStatus` to `TradeResponse` and its OpenAPI schema**

`be/src/api/server.ts`: add `usdValueStatus: 'priced' | 'pending' | 'unavailable';` to `TradeResponse`.
`be/src/api/schemas.ts`: add `usdValueStatus: { type: 'string', enum: ['priced', 'pending', 'unavailable'] }` to `trade`, and update the existing comment above `usdValue`/`usdValueApprox` — it currently says "usdValue is an approximation (current Chainlink price, not the price at trade time)"; that sentence is now false, replace it with the historical-valuation explanation.

- [ ] **Step 5: Run to verify the tests pass**

Run the Step 2 command. Expected: PASS, all new tests plus every pre-existing test in this `describe` block (some pre-existing tests in this block assert the OLD current-price-fallback behavior — e.g. "computes an approximate usdValue for a trade whose quote asset has a known feed" presumably asserts against `readUsdPrice`'s mocked latest price; update that test's fixture/assertion to seed a `quote_usd_price_rounds` row instead and assert the historical value, since the behavior it pins is being deliberately replaced — note this as a Ruling if you execute this plan, since the plan is intentionally changing a previously-pinned behavior).

- [ ] **Step 6: Commit**

```bash
git add be/src/api/store.ts be/src/api/server.ts be/src/api/schemas.ts be/src/api/store.integration.test.ts be/openapi.json fe/src/api/schema.ts
git commit -m "feat: value /trades rows at their own historical quote price, add usdValueStatus, enqueue demand-driven backfill"
```

---

### Task 11: Performance benchmark against synthetic representative-scale data

**Files:**
- Create: `be/src/cli/benchmarkVolumeRanking.ts`

**Interfaces:**
- Consumes: `buildSyntheticTradeBatch` (Task 8), the real `listLaunches({ sort: 'volume24hUsd' })` path (Task 9).
- Produces: a printed latency report; no new exported interface (this is a one-shot measurement script, not production code).

- [ ] **Step 1: Write the benchmark script**

```typescript
import { createDatabase } from '../db/client.js';
import { createApiStore } from '../api/store.js';
import { buildSyntheticTradeBatch } from './generateSyntheticTrades.js';
// Plus whatever direct pool.query helpers Task 8's CLI already wrote for bulk-inserting
// sources/launches/venues/quote_usd_feeds/quote_usd_price_rounds — reuse them, don't duplicate.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(databaseUrl);

async function main() {
  // 1. Seed (or confirm already seeded by Task 8's generator) at least 5,000 synthetic launches and
  //    5,000,000+ synthetic trades across them, with a realistic quote-asset distribution (reuse
  //    the real verified feeds from Task 1-6's live work, or synthetic verified feeds + rounds —
  //    either way every trade's quote asset must have a verified feed + a backfilled round at its
  //    exact position, or the benchmark is measuring the fast "null" path, not the real one).
  // 2. Run store.listLaunches({ limit: 50, chainId: 4663, sort: 'volume24hUsd' }) 5 times, discard
  //    the first (cold cache) run, report p50/p95 of the remaining 4 in milliseconds.
  // 3. Run EXPLAIN (ANALYZE, BUFFERS) on the core ranking query directly via pool.query and print it
  //    — this is what tells you WHERE the time goes if the gate fails (missing index, bad join order).
  // 4. Print a clear PASS/FAIL line against the spec's gate: p95 comfortably under the frontend's
  //    8-second API timeout — "comfortably" meaning leave real margin (e.g. treat a p95 over 3s as
  //    FAIL even though 3s is technically under 8s), since this is synthetic data on a dev machine,
  //    not a true production load test.
  await pool.end();
}
main();
```

- [ ] **Step 2: Run it against Task 8's seeded data**

Run: `cd be && DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npx tsx --env-file-if-exists=.env src/cli/generateSyntheticTrades.ts && npx tsx --env-file-if-exists=.env src/cli/benchmarkVolumeRanking.ts`
Record the actual printed p50/p95 numbers and the `EXPLAIN ANALYZE` output in this task's ledger line (if executing via `superpowers:executing-plans`) or in a commit message — this is real evidence the spec explicitly requires ("Measure and record the query plan/latency on representative data").

- [ ] **Step 3: Decide and act on the gate — do not guess a fallback design**

**If PASS:** nothing further to build. Record the numbers and move to Task 12.

**If FAIL:** stop here. Do not design or implement an Envio-maintained rolling-volume summary table speculatively — the spec allows it ("An Envio-maintained summary is required if that read path misses the performance gate") but its exact shape depends on WHERE the real bottleneck is (the `EXPLAIN ANALYZE` from Step 2 tells you: missing index on `trades(chain_id, timestamp)` for the global scan is the most likely single fix, worth trying with a new index and re-benchmarking before concluding a full materialized-summary redesign is needed at all). If a straightforward index addition (new migration, `CREATE INDEX CONCURRENTLY` per the spec's own deployment-procedure note) brings it under the gate, add that index as a new task here and re-run the benchmark to confirm. If it still fails after that, stop and get the user's explicit sign-off on a materialized-summary design before writing any further code — this plan does not pre-authorize that larger redesign.

- [ ] **Step 4: Commit**

```bash
git add be/src/cli/benchmarkVolumeRanking.ts
git commit -m "test: benchmark the global volume24hUsd ranking query against synthetic representative-scale data"
```

(If Step 3 added an index, include its migration in this same commit and mention the before/after numbers in the commit message.)

---

### Task 12: Frontend — remove Trending, wire the two real tabs

**Files:**
- Modify: `fe/src/features/launches/launch-list.tsx`
- Modify: `fe/src/app/page.tsx`
- Test: `fe/src/features/launches/launch-list.test.tsx`

**Interfaces:**
- Consumes: `officialVolume24hUsd`/`officialVolume24hUsdApprox` (Task 9), the generated `fe/src/api/schema.ts` types (regenerated in Task 9 Step 7).
- Produces: nothing further consumed by other tasks except Task 13 (same file).

- [ ] **Step 1: Write the failing tests**

In `launch-list.test.tsx`, remove (not just skip) every test referencing the `trending` tab value or `sortByTrending` (search the file for `trending`/`change1h` sort assertions from the prior plan and delete them — the spec explicitly says "remove the Trending client-side sorter and its tests"). Add:

```typescript
it('shows exactly two tabs: All and Recently launched', () => {
  render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
  const tabs = screen.getByRole('navigation', { name: /filter by tab/i });
  expect(within(tabs).getAllByRole('link')).toHaveLength(2);
  expect(within(tabs).getByRole('link', { name: 'All' })).toBeInTheDocument();
  expect(within(tabs).getByRole('link', { name: 'Recently launched' })).toBeInTheDocument();
});

it('a stale ?tab=trending resolves to the All tab, not a hidden third state', () => {
  render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} tab="trending" />);
  const tabs = screen.getByRole('navigation', { name: /filter by tab/i });
  expect(within(tabs).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
});

it('shows the approximate USD 24H volume when available, with the quote amount still accessible', () => {
  render(<LaunchList page={{ items: [launch({ officialVolume24hUsd: '1234.56', officialVolume24hUsdApprox: true, officialVolume24h: '0.5' })], nextCursor: null }}
    sources={oneChainOneSource} error={false} />);
  const table = screen.getByRole('table', { name: /launch list/i });
  expect(within(table).getByText(/~\$1234\.56/)).toBeInTheDocument();
});

it('shows the honest unavailable state (not a fabricated zero) when officialVolume24hUsd is null', () => {
  render(<LaunchList page={{ items: [launch({ officialVolume24hUsd: null })], nextCursor: null }} sources={oneChainOneSource} error={false} />);
  expect(screen.getAllByText('No data yet').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd fe && npx vitest run src/features/launches/launch-list.test.tsx`
Expected: FAIL — Trending still present, USD cell not implemented.

- [ ] **Step 3: Implement**

In `launch-list.tsx`: delete `sortByTrending`, remove `'trending'` from `TABS`, change `activeTab === 'trending' ? sortByTrending(page.items) : page.items` to just `page.items` (ranking is now server-side via `sort`), and make the `tab` prop map to a `sort` query param instead of a client-side reorder: `All` → `sort=volume24hUsd`, `Recently launched` → `sort=recent` (or omitted). A URL with `tab=trending` that no longer matches any `TABS` entry must fall back to `activeTab = 'all'` — check the existing `const activeTab = tab ?? 'all'` line; since `'trending'` is no longer in `TABS`, add a guard: `const activeTab = TABS.some((t) => t.value === tab) ? tab! : 'all'`.

Change the 24H volume cell: when `officialVolume24hUsd` is non-null, render `~$${value}` (always `~`, since `officialVolume24hUsdApprox` is true for every positive priced value per the spec) with the existing quote-unit amount as secondary/title text; when null, keep the existing `formatQuote(null, ...)` → "No data yet" path unchanged.

- [ ] **Step 4: Run to verify tests pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Wire `page.tsx`'s `tab` → `sort` query param**

In `fe/src/app/page.tsx`, translate `tab` into the `sort` parameter passed to `getLaunches` (`tab === 'recent' ? 'recent' : 'volume24hUsd'`), and update `fe/src/api/client.ts`'s `LaunchQuery`/`getLaunches` to forward `sort`.

- [ ] **Step 6: Run the full frontend suite, typecheck, lint, build**

Run: `cd fe && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add fe/src/features/launches/launch-list.tsx fe/src/features/launches/launch-list.test.tsx fe/src/app/page.tsx fe/src/api/client.ts
git commit -m "feat: replace client-side Trending with server-ranked sort=volume24hUsd, keep Recently launched"
```

---

### Task 13: Frontend — trade table `usdValueStatus` UI with bounded-backoff refetch

**Files:**
- Modify: `fe/src/features/launch/trade-list.tsx`
- Test: `fe/src/features/launch/trade-list.test.tsx` (create if it doesn't exist yet — check first)

**Interfaces:**
- Consumes: `usdValueStatus` (Task 10), the regenerated `fe/src/api/schema.ts` types.
- Produces: nothing further consumed by other tasks — this is the plan's last task.

- [ ] **Step 1: Write the failing tests**

```typescript
it('shows a loading state for a pending trade USD value, keeping the onchain amount visible', () => {
  render(<TradeList trades={[trade({ usdValue: null, usdValueApprox: false, usdValueStatus: 'pending' })]} venues={[]} quoteSymbol="ROBIN" explorerBase={undefined} />);
  expect(screen.getByText(/calculating|loading/i)).toBeInTheDocument();
  expect(screen.getByText(trade().tokenAmount)).toBeInTheDocument(); // onchain amount still shown
});

it('shows the honest unavailable state for usdValueStatus unavailable, distinct from pending', () => {
  render(<TradeList trades={[trade({ usdValue: null, usdValueApprox: false, usdValueStatus: 'unavailable' })]} venues={[]} quoteSymbol="ROBIN" explorerBase={undefined} />);
  expect(screen.getByText(/no data yet|unavailable/i)).toBeInTheDocument();
  expect(screen.queryByText(/calculating|loading/i)).not.toBeInTheDocument();
});

it('shows the real historical USD value for a priced trade, labeled as historical not current', () => {
  render(<TradeList trades={[trade({ usdValue: '42.5', usdValueApprox: true, usdValueStatus: 'priced' })]} venues={[]} quoteSymbol="ROBIN" explorerBase={undefined} />);
  expect(screen.getByText(/\$42\.5/)).toBeInTheDocument();
});
```

Check the existing `trade-list.test.tsx`'s (or wherever trades are tested — this project's e2e/unit test file layout may differ; search for the current `TradeList` test file before creating a new one) `trade()` fixture helper first and add `usdValueStatus` to it with a sensible default, matching how Task 6/8 of the prior session's plan added new fields to shared fixture helpers without duplicating them.

- [ ] **Step 2: Run to verify failure**

Run: `cd fe && npx vitest run <the real path to the trade list test file>`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `trade-list.tsx`, branch the USD cell on `trade.usdValueStatus`: `'pending'` renders a small loading indicator (text is sufficient, no new dependency needed) alongside the already-rendered onchain quote amount; `'unavailable'` renders the existing "No data yet" treatment; `'priced'` renders `formatUsd(trade.usdValue)`. Update the existing tooltip/help text (if any, from the prior session's `tvlTooltip`-style pattern) to say the value is the historical quote price near that trade's own execution time, not current/latest.

For the bounded-backoff refetch of pages containing `pending` rows: check whether this page already participates in the existing SSE/polling refresh mechanism (`fe/src/hooks/use-live-refresh.ts`, referenced in README.md's FE section) before adding a second, competing refetch mechanism — if a trade page can already re-render on a live-refresh tick, wire the "has any pending row" check into that existing path (e.g. shorten the poll interval only while a `pending` row is present, bounded to a maximum of a few retries) rather than building an independent `setInterval` in this component. Read that hook's current implementation first; this step's exact code depends on what's actually there.

- [ ] **Step 4: Run to verify tests pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full frontend suite, typecheck, lint, build, e2e**

Run: `cd fe && npm test && npx tsc --noEmit && npm run lint && npm run build && npm run test:e2e`
Expected: all green. (`fe/e2e/mock-api.ts`'s fixed trade fixtures will need a `usdValueStatus` field added — same pattern as the prior session's `logoUri`/etc. additions there — or every trade-table e2e assertion involving USD values will break; check and fix before calling this done.)

- [ ] **Step 6: Commit**

```bash
git add fe/src/features/launch/trade-list.tsx fe/e2e/mock-api.ts
git commit -m "feat: show historical-price trade USD status (priced/pending/unavailable) with honest loading/unavailable states"
```

---

### Task 14: Migrate the existing latest-price reader onto the persisted feed registry

The spec requires "Keep the quote/feed mapping in one place... replacing the split hardcoded `FEEDS` map in `usdPricing.ts` and in-memory `quoteFeedRegistry.ts` as independent sources of truth." Tasks 1–10 built the new persisted registry and historical valuation path for trades/volume, but `be/src/market/usdPricing.ts`'s `readUsdPrice` (still used by TVL and FDV — `be/src/market/tvlStats.ts`'s `readCurrentTvl`, and `be/src/api/store.ts`'s `computeStats`) still has its own independent hardcoded `FEEDS` map and the in-memory `quoteFeedRegistry.ts` fallback. Left unmigrated, a newly-verified feed from Task 6's background job would price correctly for volume/trades but stay permanently unpriced for TVL/FDV — a real, confusing inconsistency this plan must not leave behind. Do this task last, once Tasks 1–6's registry has real rows to read.

**Files:**
- Modify: `be/src/market/usdPricing.ts`
- Modify: `be/src/market/tvlStats.ts`
- Modify: `be/src/api/store.ts`
- Create: `be/src/cli/seedKnownQuoteFeeds.ts`
- Rename+modify: `be/src/market/usdPricing.test.ts` → `be/src/market/usdPricing.integration.test.ts` (it now needs a real Postgres, matching Task 1/2/4's convention of never mocking `pool.query`)

**Interfaces:**
- Consumes: `resolveVerifiedFeed` (Task 1).
- Produces: nothing further consumed by other tasks — this is the plan's last task.

- [ ] **Step 1: Seed the 3 currently-hardcoded feeds into `quote_usd_feeds`**

```typescript
import { createDatabase } from '../db/client.js';
import { upsertQuoteFeed } from '../market/quotePricing/feedRegistry.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(databaseUrl);
const now = new Date();
const KNOWN: { quoteAssetAddress: `0x${string}`; feedAddress: `0x${string}` }[] = [
  { quoteAssetAddress: '0x0000000000000000000000000000000000000000', feedAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' },
  { quoteAssetAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', feedAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' },
  { quoteAssetAddress: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', feedAddress: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2' },
  { quoteAssetAddress: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', feedAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
];
for (const feed of KNOWN) {
  await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: feed.quoteAssetAddress, feedAddress: feed.feedAddress,
    aggregatorAddress: null, discoverySource: 'known-seed-2026-10-04', verificationStatus: 'verified', now });
}
await pool.end();
console.log(`Seeded ${KNOWN.length} known quote feeds`);
```

Add an npm script `"seed:known-quote-feeds": "tsx --env-file-if-exists=.env src/cli/seedKnownQuoteFeeds.ts"` to `be/package.json`.

Run: `cd be && DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run seed:known-quote-feeds` and the same against the `_test` database.
Expected: "Seeded 4 known quote feeds" printed each time; a `SELECT * FROM quote_usd_feeds` shows all 4 rows with `verification_status = 'verified'`.

`aggregatorAddress: null` above is a known gap for these 4 seeded rows — they won't be eligible for round backfill (Task 6's worker) until their real aggregator addresses are resolved. That's fine for this task (TVL/FDV only need `resolveVerifiedFeed`'s `feedAddress`, not the aggregator); if volume-ranking/historical trade pricing for these specific quote assets needs backfilled rounds sooner than the natural job queue gets to them, enqueue a one-off `feed_resolution` job for each via `enqueueFeedResolutionJob` instead of seeding `verified` rows directly — note this tradeoff to the user rather than silently picking one.

- [ ] **Step 2: Write the failing test for `readUsdPrice`'s new DB-backed resolution**

Rename `be/src/market/usdPricing.test.ts` to `be/src/market/usdPricing.integration.test.ts`. Read its current content in full first (it has ~14 existing tests against the hardcoded `FEEDS` map and the injectable `registry` parameter) and rewrite its setup to seed real rows into `quote_usd_feeds` in a `beforeAll`/clean up in `afterAll` (mirroring Task 1's integration-test fixture pattern) instead of relying on the hardcoded map or an injected fake registry object. Add:

```typescript
it('reads a feed resolved from the persisted quote_usd_feeds table, not a hardcoded map', async () => {
  const freshQuote = '0x9999999999999999999999999999999999feed';
  await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: freshQuote, feedAddress: usdgFeedAddressFixture,
    aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'decimals') return 8;
    if (functionName === 'latestRoundData') return [1n, 99992674n, 1n, 1_790_782_723n, 1n];
    throw new Error(`unexpected ${functionName}`);
  });
  const result = await readUsdPrice(pool, { readContract }, freshQuote, () => 1_790_859_457_000);
  expect(result).toEqual({ priceUsd: 0.99992674, updatedAt: 1_790_782_723, source: 'chainlink' });
});
```

Every pre-existing test in the file must also be updated to pass `pool` as `readUsdPrice`'s new first parameter (its exact position in the signature is decided in Step 3 below — update the tests to match once written, not before).

- [ ] **Step 3: Run to verify failure**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run --config vitest.integration.config.ts src/market/usdPricing.integration.test.ts`
Expected: FAIL — `readUsdPrice` doesn't accept a `pool` argument yet / still reads the hardcoded map.

- [ ] **Step 4: Rewrite `readUsdPrice` to delegate to `resolveVerifiedFeed`**

In `be/src/market/usdPricing.ts`: remove the `FEEDS` constant and the `registry` parameter entirely. Change the signature to
`export async function readUsdPrice(pool: Pool, client: UsdPriceClient, quoteAssetAddress: string, now: () => number = Date.now): Promise<UsdPrice | null>`, and inside, replace `const feedAddress = FEEDS[key] ?? await registry.resolve(key);` with:

```typescript
const feed = await resolveVerifiedFeed(pool, 4663, key);
if (!feed) return null;
const feedAddress = feed.feedAddress;
```

Import `resolveVerifiedFeed` from `./quotePricing/feedRegistry.js` and `Pool` from `pg`. Delete `be/src/market/quoteFeedRegistry.ts` and its test entirely — its only remaining purpose (live-directory discovery) was already moved into `be/src/market/quotePricing/feedDiscovery.ts` in Task 5, and its only remaining consumer was this now-removed `registry` parameter.

- [ ] **Step 5: Update the two real call sites**

`be/src/market/tvlStats.ts`: add `pool: Pool` as `readCurrentTvl`'s first parameter (import `Pool` from `pg`), pass it through to `readUsdPrice(pool, client, input.quote, now)`.

`be/src/api/store.ts`: `computeTvl` and `computeStats` already have `pool` in scope — update their `readUsdPrice(rpcClient, ...)` call (computeStats, ~line 95) to `readUsdPrice(pool, rpcClient, ...)`, and `computeTvl`'s call into `readCurrentTvl(rpcClient, ...)` to `readCurrentTvl(pool, rpcClient, ...)`.

- [ ] **Step 6: Run to verify the rewritten test file passes**

Run the Step 3 command. Expected: PASS, every test in the file (old behavior preserved via the seeded rows from Step 1/the test's own `beforeAll`, new DB-backed test passing).

- [ ] **Step 7: Run the full backend suite, typecheck, lint, integration suite**

Run: `cd be && npm test && npx tsc --noEmit && npm run lint && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`
Expected: all green — this change touches a widely-used shared function, so a full green run here matters more than usual.

- [ ] **Step 8: Commit**

```bash
git add be/src/market/usdPricing.ts be/src/market/tvlStats.ts be/src/api/store.ts be/src/cli/seedKnownQuoteFeeds.ts be/package.json
git rm be/src/market/quoteFeedRegistry.ts be/src/market/quoteFeedRegistry.test.ts
git mv be/src/market/usdPricing.test.ts be/src/market/usdPricing.integration.test.ts
git commit -m "feat: migrate the latest-price reader (TVL/FDV) onto the persisted quote feed registry"
```

## Deferred to a later, explicitly-scoped pass (not part of this plan)

Per the spec's own "Out of scope": the `Pools` (other pools) discovery/ingestion/UI work unit, exact external market ticks at swap time, wallet/trading controls, any indexer rewrite beyond this plan's bounded additions, and live deployment. Also deferred: whatever Task 11 Step 3's FAIL branch would require (a materialized Envio-maintained volume summary) — only pursued if the live benchmark actually fails and only after the user's explicit sign-off on that specific design.
