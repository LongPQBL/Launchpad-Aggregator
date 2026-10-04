# Uniswap-Style Launch List/Detail UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the FE launch list table and detail page to Uniswap's
column/section layout (kept in this project's own light/blue theme), closing
the data gaps that exposes: token logo, description, website, Twitter,
launch age, and 1H/1D price change.

**Architecture:** A new shared Pons on-chain extended-metadata reader
(`logo()`/`description()`/`socials()`, plus a block-timestamp read for launch
age) is wired into the existing once-per-launch V1 and V2 sync paths,
persisting into five new nullable `launches` columns — never a live
per-page-view RPC call. A new 1H/1D price-change computation reuses the same
official-trade price history as the existing 52-week high/low. The API
passes the new DB fields straight through plus the new computed fields; the
FE consumes them in a redesigned table and a new detail-page "About" section,
resolving `ipfs://` logos through a verified-working public gateway with a
placeholder-avatar fallback.

**Tech Stack:** TypeScript, viem, PostgreSQL, Drizzle, Fastify, Next.js,
Tailwind, Vitest.

**Spec:** [docs/superpowers/specs/2026-10-04-uniswap-style-launch-ui-design.md](../specs/2026-10-04-uniswap-style-launch-ui-design.md)

## Global Constraints

- Never fabricate data: a `null` stays `null` end-to-end (DB → API → FE). No
  pill, column, or badge is ever rendered from partial/guessed data.
- Metadata and timestamp reads happen exactly once per launch, at sync time
  (inside `runSync.ts`/`runSyncV2.ts`'s existing per-launch RPC batch) —
  never a live RPC call per page view.
- Historical launches (166K+ already indexed) are explicitly **not**
  backfilled in this plan; they keep `null` extended-metadata fields.
- Keep the existing light/blue theme. Only the column layout, filter
  placement, and About-section structure are borrowed from Uniswap — never
  its dark palette.
- The chain filter/badge is cosmetic only (Robinhood Chain is the only
  option today) — do not build multi-chain filtering infrastructure.
- The only verified-working public IPFS gateway is
  `https://gateway.pinata.cloud/ipfs/`. Do not add `cloudflare-ipfs.com`
  (its DNS no longer resolves) or assume `ipfs.io` is reliable (it returned
  429 when tested).
- The real Robinhood Chain explorer is `https://robinhoodchain.blockscout.com`
  — `hoodexplorer.org` is a known non-official/phishing lookalike, never use
  it.

## Review Focus

- A launch whose token contract doesn't implement `logo()`/`description()`/
  `socials()` at all (non-Pons-shaped or malformed contract) must still get
  indexed with its required fields (name/symbol/decimals) intact — the
  extended-metadata read failing must never throw out of the sync path.
- A launch younger than 1 day must show a `null` (not fabricated/zero) 1D
  change; a launch with zero official trades must show `null` for FDV,
  `change1h`, and `change1d` consistently, not a mix of real and fabricated
  values.
- An IPFS logo that 404s or times out at request time must fall back to the
  placeholder avatar, never an infinite spinner or a broken-image icon.
- The Launchpad filter and the chain badge must not visually imply
  multi-chain/multi-launchpad support that doesn't exist yet (e.g. a
  dropdown that looks interactive but silently does nothing when a
  non-existent option would be picked).
- Reading `socials()`'s 5-tuple must map `website`/`twitter` to the correct
  positions (`[twitter, telegram, discord, website, farcaster]` — verified
  against real Pons tokens this session) — a swapped index would silently
  put a Telegram link under the "Website" pill.

---

### Task 1: Shared Pons extended-metadata reader

**Files:**
- Create: `be/src/launchpads/pons/extendedMetadata.ts`
- Test: `be/src/launchpads/pons/extendedMetadata.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (viem `Address`, `parseAbi` only).
- Produces: `export interface ExtendedTokenMetadata { logoUri: string | null; description: string | null; websiteUrl: string | null; twitterUrl: string | null }`,
  `export interface ExtendedMetadataReadClient { readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown> }`,
  `export async function readExtendedTokenMetadata(client: ExtendedMetadataReadClient, token: Address): Promise<ExtendedTokenMetadata>` —
  **never throws**; any individual call (or all three) reverting, timing
  out, or returning an unexpected shape degrades that field (or all of
  them) to `null`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { readExtendedTokenMetadata } from './extendedMetadata.js';

const TOKEN = '0xadd59906506bf2149212421e9d23db399f588efe' as Address;

describe('readExtendedTokenMetadata', () => {
  it('reads logo/description/socials and maps the socials tuple to the right fields', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') return 'ipfs://bafkreidqqf3trgvnsqj2xccqx3ozaign3at36jbqteb6uskpltjwybfdku';
      if (functionName === 'description') return 'Air-gapped AI inside your building.';
      // [twitter, telegram, discord, website, farcaster] — verified order against a real token this session
      if (functionName === 'socials') return ['https://x.com/garnet_grid', '', '', 'https://garnet.example', ''];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({
      logoUri: 'ipfs://bafkreidqqf3trgvnsqj2xccqx3ozaign3at36jbqteb6uskpltjwybfdku',
      description: 'Air-gapped AI inside your building.',
      websiteUrl: 'https://garnet.example',
      twitterUrl: 'https://x.com/garnet_grid',
    });
  });

  it('treats an empty-string social/description as null, not an empty pill', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') return 'ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu';
      if (functionName === 'description') return '';
      if (functionName === 'socials') return ['', '', '', '', ''];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({
      logoUri: 'ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu',
      description: null,
      websiteUrl: null,
      twitterUrl: null,
    });
  });

  it('degrades every field to null, without throwing, when the contract does not implement these functions', async () => {
    const readContract = vi.fn(async () => { throw new Error('execution reverted'); });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({ logoUri: null, description: null, websiteUrl: null, twitterUrl: null });
  });

  it('degrades only the failing field to null when one of the three calls reverts and the others succeed', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') throw new Error('execution reverted');
      if (functionName === 'description') return 'Real description';
      if (functionName === 'socials') return ['https://x.com/real', '', '', '', ''];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({ logoUri: null, description: 'Real description', websiteUrl: null, twitterUrl: 'https://x.com/real' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd be && npx vitest run src/launchpads/pons/extendedMetadata.test.ts`
Expected: FAIL — `Cannot find module './extendedMetadata.js'`

- [ ] **Step 3: Write the implementation**

```typescript
import { parseAbi, type Address } from 'viem';

export const ponsExtendedMetadataAbi = parseAbi([
  'function logo() view returns (string)',
  'function description() view returns (string)',
  'function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)',
]);

export interface ExtendedTokenMetadata {
  logoUri: string | null;
  description: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
}

export interface ExtendedMetadataReadClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readOneOrNull<T>(promise: Promise<T>): Promise<T | null> {
  try { return await promise; } catch { return null; }
}

export async function readExtendedTokenMetadata(client: ExtendedMetadataReadClient, token: Address): Promise<ExtendedTokenMetadata> {
  const [logo, description, socials] = await Promise.all([
    readOneOrNull(client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'logo' })),
    readOneOrNull(client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'description' })),
    readOneOrNull(client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'socials' })),
  ]);
  const socialsTuple = Array.isArray(socials) ? socials : [];
  return {
    logoUri: stringOrNull(logo),
    description: stringOrNull(description),
    // socials() returns [twitter, telegram, discord, website, farcaster] — verified order against
    // a real Pons token this session; do not reorder without re-verifying on-chain.
    twitterUrl: stringOrNull(socialsTuple[0]),
    websiteUrl: stringOrNull(socialsTuple[3]),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd be && npx vitest run src/launchpads/pons/extendedMetadata.test.ts`
Expected: PASS — 4/4

- [ ] **Step 5: Commit**

```bash
git add be/src/launchpads/pons/extendedMetadata.ts be/src/launchpads/pons/extendedMetadata.test.ts
git commit -m "feat: add shared Pons extended-metadata reader (logo/description/socials)"
```

---

### Task 2: Migration — add extended-metadata and launch-timestamp columns

**Files:**
- Modify: `be/src/db/schema.ts`
- Create: `be/drizzle/0019_<auto-generated-name>.sql` (via `db:generate`, do not hand-write)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `launches` table gains `logoUri: text('logo_uri')`,
  `description: text('description')`, `websiteUrl: text('website_url')`,
  `twitterUrl: text('twitter_url')`, `launchTimestamp: integer('launch_timestamp')`
  — all nullable, no default. Task 3/4 write these; Task 6 reads them.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `be/src/db/schema.ts`, inside the existing `launches` table definition
(the one with `lifecycleStatus`, `v4PoolFee`, `v4TickSpacing`), add directly
after `v4TickSpacing: integer('v4_tick_spacing'),`:

```typescript
  logoUri: text('logo_uri'),
  description: text('description'),
  websiteUrl: text('website_url'),
  twitterUrl: text('twitter_url'),
  launchTimestamp: integer('launch_timestamp'),
```

- [ ] **Step 2: Generate the migration**

Run: `cd be && npm run db:generate`
Expected: a new `be/drizzle/00NN_<name>.sql` file containing five
`ALTER TABLE "launches" ADD COLUMN ...` statements (one per new column, all
nullable, no `NOT NULL`/`DEFAULT`), plus an updated
`be/drizzle/meta/00NN_snapshot.json` and `be/drizzle/meta/_journal.json`.
Read the generated SQL file and confirm it has exactly these five additive
`ADD COLUMN` lines and nothing else (no table drops, no type changes to
existing columns) before proceeding.

- [ ] **Step 3: Apply the migration to the local dev DB**

Run: `cd be && DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run db:migrate`
Expected: migration applies with no errors; existing rows get `NULL` in all
five new columns (verify with
`docker exec -i launchpad-aggregator-postgres-1 psql -U launchpad -d launchpad -c "SELECT logo_uri, description, website_url, twitter_url, launch_timestamp FROM launches LIMIT 1;"`
— all five columns show `NULL` for an existing row, not an error).

- [ ] **Step 4: Apply the same migration to the integration test DB**

Run: `cd be && DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run db:migrate`
Expected: same clean apply, confirming the test DB stays in sync with dev.

- [ ] **Step 5: Commit**

```bash
git add be/src/db/schema.ts be/drizzle/00NN_*.sql be/drizzle/meta/00NN_snapshot.json be/drizzle/meta/_journal.json
git commit -m "feat: add nullable logo/description/website/twitter/launch_timestamp columns to launches"
```

---

### Task 3: Wire extended metadata + launch timestamp into the V1 sync path

**Files:**
- Modify: `be/src/domain/types.ts`
- Modify: `be/src/launchpads/pons/v1/adapter.ts`
- Modify: `be/src/envioSync/runSync.ts`
- Test: `be/src/launchpads/pons/v1/adapter.test.ts`
- Test: `be/src/envioSync/runSync.test.ts`

**Interfaces:**
- Consumes: `readExtendedTokenMetadata` (Task 1), the new `launches` columns
  (Task 2).
- Produces: `Launch` (domain type) gains
  `logoUri?: string | null; description?: string | null; websiteUrl?: string | null; twitterUrl?: string | null; launchTimestamp?: number | null`
  — optional, following the existing `v4PoolFee?: number | null` pattern.
  `hydrateV1Launch`'s signature gains a 5th parameter carrying these five
  values, already read by the caller (sync layer owns the RPC read timing,
  not the pure hydrate function — matches the project's existing
  separation between RPC-reading and pure-hydrating code).

- [ ] **Step 1: Write the failing test for `hydrateV1Launch` accepting extended metadata**

In `be/src/launchpads/pons/v1/adapter.test.ts`, find the existing test that
calls `hydrateV1Launch(launchEvent, factory, metadata, graduated)` and add:

```typescript
it('carries extended metadata and launch timestamp through onto the Launch object when provided', () => {
  const extended = { logoUri: 'ipfs://bafkreitest', description: 'A real token', websiteUrl: 'https://example.com', twitterUrl: 'https://x.com/example' };
  const { launch } = hydrateV1Launch(launchEvent, legacy, metadata, false, { ...extended, launchTimestamp: 1_700_000_000 });
  expect(launch.logoUri).toBe('ipfs://bafkreitest');
  expect(launch.description).toBe('A real token');
  expect(launch.websiteUrl).toBe('https://example.com');
  expect(launch.twitterUrl).toBe('https://x.com/example');
  expect(launch.launchTimestamp).toBe(1_700_000_000);
});

it('defaults extended metadata and launch timestamp to null when the 5th argument is omitted', () => {
  const { launch } = hydrateV1Launch(launchEvent, legacy, metadata, false);
  expect(launch.logoUri).toBeNull();
  expect(launch.description).toBeNull();
  expect(launch.websiteUrl).toBeNull();
  expect(launch.twitterUrl).toBeNull();
  expect(launch.launchTimestamp).toBeNull();
});
```

(Use whatever existing `launchEvent`/`legacy`/`metadata` fixtures the
surrounding tests in that file already define — do not redefine them.)

- [ ] **Step 2: Run to verify failure**

Run: `cd be && npx vitest run src/launchpads/pons/v1/adapter.test.ts`
Expected: FAIL — `launch.logoUri` is `undefined`, not the expected value
(the 5th parameter doesn't exist yet).

- [ ] **Step 3: Extend the `Launch` domain type**

In `be/src/domain/types.ts`, inside the `Launch` interface, directly after
`v4TickSpacing?: number | null;`, add:

```typescript
  logoUri?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  launchTimestamp?: number | null;
```

- [ ] **Step 4: Extend `hydrateV1Launch`**

In `be/src/launchpads/pons/v1/adapter.ts`, change the `hydrateV1Launch`
signature (currently
`export function hydrateV1Launch(event: V1LaunchEvent, factory: FactorySource, metadata: V1TokenMetadata, graduated: boolean): LaunchWithVenue`)
to:

```typescript
export function hydrateV1Launch(event: V1LaunchEvent, factory: FactorySource, metadata: V1TokenMetadata, graduated: boolean,
  extended?: { logoUri: string | null; description: string | null; websiteUrl: string | null; twitterUrl: string | null; launchTimestamp: number | null }): LaunchWithVenue {
```

and inside the function body, where the returned `Launch` object is
constructed, add:

```typescript
    logoUri: extended?.logoUri ?? null,
    description: extended?.description ?? null,
    websiteUrl: extended?.websiteUrl ?? null,
    twitterUrl: extended?.twitterUrl ?? null,
    launchTimestamp: extended?.launchTimestamp ?? null,
```

- [ ] **Step 5: Run to verify the adapter test passes**

Run: `cd be && npx vitest run src/launchpads/pons/v1/adapter.test.ts`
Expected: PASS, including both new tests.

- [ ] **Step 6: Write the failing integration test**

`be/src/envioSync/runSync.test.ts` is a narrow unit test for
`readV1TokenMetadata` alone — it does **not** exercise the DB-writing sync
functions. The function that actually writes into the real `launches` table
is `syncV1LegacyToReal`, tested (DB-backed, `TEST_DATABASE_URL`-gated) in
`be/src/envioSync/runSync.integration.test.ts`'s
`describe('syncV1LegacyToReal')` block. Read that block's existing test
first (it builds `realToken`/`poolAddress`/fixture rows in
`envio_fixture_v1."RawLaunch"`/`"RawSwap"` and a `client.readContract` mock,
then asserts on `db.select().from(launches).where(eq(launches.tokenAddress, realToken))`)
and add two parallel tests inside the same `describe` block, reusing its
exact `realToken`/fixture-insertion setup:

```typescript
it('reads and persists extended metadata and launch timestamp alongside the required V1 fields', async () => {
  const client = {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (address.toLowerCase() === legacyFactoryLower) return { exists: false }; // not used by V1, kept for parity with the surrounding mock shape if present
      if (functionName === 'name') return 'Test Token';
      if (functionName === 'symbol') return 'TEST';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return poolAddress;
      if (functionName === 'logo') return 'ipfs://bafkreitest';
      if (functionName === 'description') return 'A real token';
      if (functionName === 'socials') return ['https://x.com/example', '', '', 'https://example.com', ''];
      throw new Error(`unexpected functionName ${functionName}`);
    },
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  };
  await syncV1LegacyToReal(envioPool, db, fixtureTables, client, 4663);
  const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, realToken));
  expect(row.logoUri).toBe('ipfs://bafkreitest');
  expect(row.description).toBe('A real token');
  expect(row.websiteUrl).toBe('https://example.com');
  expect(row.twitterUrl).toBe('https://x.com/example');
  expect(row.launchTimestamp).toBe(1_700_000_000);
});

it('still indexes the launch with null extended fields when extended-metadata and timestamp reads fail', async () => {
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'name') return 'Test Token';
      if (functionName === 'symbol') return 'TEST';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return poolAddress;
      throw new Error('execution reverted'); // logo/description/socials all fail
    },
    getBlock: async () => { throw new Error('timeout'); },
  };
  await syncV1LegacyToReal(envioPool, db, fixtureTables, client, 4663);
  const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, realToken));
  expect(row.name).toBe('Test Token'); // required fields still indexed
  expect(row.logoUri).toBeNull();
  expect(row.launchTimestamp).toBeNull();
});
```

Match whatever this test file's actual call signature for
`syncV1LegacyToReal` turns out to be exactly (parameter order/count) — read
it from the function definition in `runSync.ts`, not from this plan's
guess, before writing this step for real.

- [ ] **Step 7: Run to verify failure**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSync.integration.test.ts`
Expected: FAIL — `row.logoUri` is `undefined` (column not populated yet).

- [ ] **Step 8: Wire the read and the insert in `runSync.ts`**

In `be/src/envioSync/runSync.ts`, import
`readExtendedTokenMetadata` from `../launchpads/pons/extendedMetadata.js`.
There are two separate per-launch metadata pre-pass loops in this file (one
feeding `syncV1LegacyOnce`'s staging write, one feeding
`syncV1LegacyToReal`'s real write) — each already builds a
`metadataByToken`/`graduatedByToken` pair of `Map`s in a loop, then looks
them up later when calling `hydrateV1Launch`. In **both** loops, add a
third map and populate it alongside the existing one:

```typescript
const extendedByToken = new Map<string, { logoUri: string | null; description: string | null; websiteUrl: string | null; twitterUrl: string | null; launchTimestamp: number | null }>();
```

and inside the loop body, change the existing

```typescript
    const [metadata, graduated] = await Promise.all([
      readV1TokenMetadata(rpcClient, tokenAddress as Address),
      readV1Graduation(rpcClient, tokenAddress as Address, factory.factory),
    ]);
```

to

```typescript
    const [metadata, graduated, extended] = await Promise.all([
      readV1TokenMetadata(rpcClient, tokenAddress as Address),
      readV1Graduation(rpcClient, tokenAddress as Address, factory.factory),
      readExtendedTokenMetadata(rpcClient, tokenAddress as Address),
    ]);
    let launchTimestamp: number | null = null;
    try {
      const block = await rpcClient.getBlock({ blockNumber: BigInt(raw.blockNumber) });
      launchTimestamp = Number(block.timestamp);
    } catch { /* stays null — a timestamp read failure must not block indexing the launch */ }
```

then after the existing `metadataByToken.set(...)`/`graduatedByToken.set(...)`
lines, add `extendedByToken.set(tokenAddress, { ...extended, launchTimestamp });`.
The `try`/`catch` form (not `.catch()` chained onto the call) is required
here specifically because `rpcClient`'s type in some existing tests doesn't
declare `getBlock` at all — calling a genuinely missing method throws
synchronously before any `.catch()` could attach, so only a `try`/`catch`
around the whole call degrades safely to `null` in that case, which is
exactly why Step 6's two new tests both supply `getBlock` explicitly but no
*other* existing test in this file needs to be touched at all.

At both call sites of `hydrateV1Launch` (~lines 99 and 199), change

```typescript
({ launch, venue } = hydrateV1Launch(event, factory, metadata, graduated));
```

(and the second call site's equivalent) to thread the 5th argument:

```typescript
({ launch, venue } = hydrateV1Launch(event, factory, metadata, graduated, extendedByToken.get(tokenAddress)));
```

In the `tx.insert(launches).values({...})` block (~line 105 — the
`syncV1LegacyToReal` write), add:

```typescript
          logoUri: launch.logoUri ?? null, description: launch.description ?? null,
          websiteUrl: launch.websiteUrl ?? null, twitterUrl: launch.twitterUrl ?? null,
          launchTimestamp: launch.launchTimestamp ?? null,
```

`rpcClient`'s TypeScript type used in this file must widen to optionally
include `getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>`
(optional — `?:` — not required, matching that the `try`/`catch` above
tolerates it being entirely absent at the type level too; check the actual
current type name this file imports/uses for `rpcClient` before editing it).

- [ ] **Step 9: Run to verify the integration test passes**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSync.integration.test.ts`
Expected: PASS, including both new tests and every pre-existing test in the
file (confirms the widened `hydrateV1Launch` call and the new `try`/`catch`
block didn't disturb any existing mock that lacks `getBlock`).

- [ ] **Step 10: Run the full backend test suite and typecheck**

Run: `cd be && npm test && npx tsc --noEmit`
Expected: all pass, 0 type errors — confirms the optional `Launch` fields
don't break any other code constructing a `Launch` object positionally.

- [ ] **Step 11: Commit**

```bash
git add be/src/domain/types.ts be/src/launchpads/pons/v1/adapter.ts be/src/launchpads/pons/v1/adapter.test.ts be/src/envioSync/runSync.ts be/src/envioSync/runSync.integration.test.ts
git commit -m "feat: persist Pons V1 launches' extended metadata and launch timestamp"
```

---

### Task 4: Wire extended metadata + launch timestamp into the V2 sync path

**Files:**
- Modify: `be/src/launchpads/pons/v2/adapter.ts` (`hydrateV2Launch` — the base
  hydrate function)
- Modify: `be/src/envioSync/transformV2.ts` (`hydrateV2LaunchFromEnvio` — the
  Envio-sync wrapper actually called by `runSyncV2.ts`; it constructs a
  synthetic `V2LaunchRecord` and delegates to `hydrateV2Launch`)
- Modify: `be/src/envioSync/runSyncV2.ts`
- Test: `be/src/launchpads/pons/v2/adapter.test.ts`
- Test: `be/src/envioSync/transformV2.test.ts`
- Test: `be/src/envioSync/runSyncV2.integration.test.ts`

**Interfaces:**
- Consumes: `readExtendedTokenMetadata` (Task 1), `Launch`'s new optional
  fields (Task 3), the new `launches` columns (Task 2).
- Produces: `hydrateV2Launch` AND `hydrateV2LaunchFromEnvio` both accept the
  same 5-field `extended` optional parameter shape Task 3 defined for
  `hydrateV1Launch` (as their respective last parameter) — keep the
  parameter and field names identical across V1/V2 so nothing has to
  remember two different shapes for the same concept.

- [ ] **Step 1: Write the failing adapter test**

In `be/src/launchpads/pons/v2/adapter.test.ts`, mirror Task 3's Step 1
pattern, adapted to `hydrateV2Launch`'s actual signature
(`event, factory, record, metadata, quote` per the existing test file; add
`extended` as a 6th parameter):

```typescript
it('carries extended metadata and launch timestamp through onto the Launch object when provided', () => {
  const extended = { logoUri: 'ipfs://bafkreitest', description: 'A real token', websiteUrl: 'https://example.com', twitterUrl: 'https://x.com/example' };
  const { launch } = hydrateV2Launch(event, factory, record, metadata, quote, { ...extended, launchTimestamp: 1_700_000_000 });
  expect(launch.logoUri).toBe('ipfs://bafkreitest');
  expect(launch.launchTimestamp).toBe(1_700_000_000);
});

it('defaults extended metadata and launch timestamp to null when the 6th argument is omitted', () => {
  const { launch } = hydrateV2Launch(event, factory, record, metadata, quote);
  expect(launch.logoUri).toBeNull();
  expect(launch.launchTimestamp).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd be && npx vitest run src/launchpads/pons/v2/adapter.test.ts`
Expected: FAIL — extra argument doesn't exist on the current signature /
`launch.logoUri` is `undefined`.

- [ ] **Step 3: Extend `hydrateV2Launch`**

Same pattern as Task 3 Step 4: add the optional 6th parameter with the
identical shape, default every field to `null` via `extended?.field ?? null`
in the constructed `Launch` object.

- [ ] **Step 4: Run to verify the adapter test passes**

Run: `cd be && npx vitest run src/launchpads/pons/v2/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wrapper test and extend `hydrateV2LaunchFromEnvio`**

In `be/src/envioSync/transformV2.test.ts`, add the same two-test pattern as
Step 1, calling `hydrateV2LaunchFromEnvio(event, factory, metadata, quoteAsset, extendedWithTimestamp)`
instead. Run it (`cd be && npx vitest run src/envioSync/transformV2.test.ts`),
confirm it fails, then in `be/src/envioSync/transformV2.ts` add the same
optional 5th parameter to `hydrateV2LaunchFromEnvio` and pass it straight
through to its internal `hydrateV2Launch(...)` call. Re-run to confirm PASS.

- [ ] **Step 6: Write the failing integration test**

In `be/src/envioSync/runSyncV2.integration.test.ts`'s
`describe('syncV2ToReal')` block, read its existing test (fixture setup,
mock `rpcClient`, final `db.select().from(launches)` assertion) and add the
same two parallel tests Task 3 Step 6 added for V1 — one supplying a full
`readContract`+`getBlock` mock asserting all five new columns land
correctly, one where `logo`/`description`/`socials` all throw and `getBlock`
throws, asserting the launch still gets indexed with `null` extended
columns. Match this file's actual `syncV2ToReal` call signature exactly
(read it from `runSyncV2.ts`, not from this plan's guess).

- [ ] **Step 7: Run to verify failure**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV2.integration.test.ts`
Expected: FAIL.

- [ ] **Step 8: Wire the read and the insert in `runSyncV2.ts`**

Same pattern as Task 3 Step 8: import `readExtendedTokenMetadata`, add an
`extendedByToken` map populated in the same pre-pass loop (~line 162-175;
note `row.blockNumber` here is already a `bigint` via
`BigInt(raw.blockNumber)`, usable directly in `rpcClient.getBlock({ blockNumber: row.blockNumber })`
inside the same `try`/`catch` form Task 3 used), thread
`extendedByToken.get(tokenAddress)` as the 5th argument into both
`hydrateV2LaunchFromEnvio(...)` call sites (~lines 68 and 205), and add the
five new fields to the `tx.insert(launches).values({...})` block (~line
211).

- [ ] **Step 9: Run to verify the integration test passes**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/envioSync/runSyncV2.integration.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 10: Run the full backend suite, typecheck, lint, and the full integration suite**

Run: `cd be && npm test && npx tsc --noEmit && npm run lint && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`
Expected: all green. Run the integration suite **three times** to check for
flakiness (project convention established throughout this codebase).

- [ ] **Step 11: Commit**

```bash
git add be/src/launchpads/pons/v2/adapter.ts be/src/launchpads/pons/v2/adapter.test.ts be/src/envioSync/transformV2.ts be/src/envioSync/transformV2.test.ts be/src/envioSync/runSyncV2.ts be/src/envioSync/runSyncV2.integration.test.ts
git commit -m "feat: persist Pons V2 launches' extended metadata and launch timestamp"
```

---

### Task 5: 1H/1D price-change computation

**Files:**
- Modify: `be/src/market/aggregate.ts`
- Test: `be/src/market/aggregate.test.ts`

**Interfaces:**
- Consumes: the same trade price shape `compute52WeekHighLow` already
  consumes (`{ high: string; low: string }[]`, but this new function needs
  the trade's own timestamp too — see the function signature below).
- Produces: `export function computePriceChange(trades: readonly { timestamp: number; price: string }[], nowSeconds: number, windowSeconds: number): string | null` —
  returns the percent change (as a decimal string, e.g. `"12.5"` for +12.5%)
  between the latest trade at or before `nowSeconds` and the latest trade at
  or before `nowSeconds - windowSeconds`, or `null` if either side has no
  trade in range.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('computePriceChange', () => {
  it('computes a positive percent change between the current price and the price one window ago', () => {
    const trades = [
      { timestamp: 1000, price: '1.0' },  // 1h ago (window = 3600)
      { timestamp: 4600, price: '1.5' },  // now
    ];
    expect(computePriceChange(trades, 4600, 3600)).toBe('50');
  });

  it('computes a negative percent change', () => {
    const trades = [
      { timestamp: 1000, price: '2.0' },
      { timestamp: 4600, price: '1.0' },
    ];
    expect(computePriceChange(trades, 4600, 3600)).toBe('-50');
  });

  it('returns null when there is no trade at or before the window start (e.g. a launch younger than the window)', () => {
    const trades = [{ timestamp: 4000, price: '1.0' }]; // launched 600s ago, window is 3600s (1h)
    expect(computePriceChange(trades, 4600, 3600)).toBeNull();
  });

  it('returns null when there is no trade at all', () => {
    expect(computePriceChange([], 4600, 3600)).toBeNull();
  });

  it('uses the latest trade at or before each boundary, not the single closest trade overall', () => {
    const trades = [
      { timestamp: 500, price: '0.5' },   // before the window start — this is the "1h ago" price
      { timestamp: 1000, price: '0.8' },  // still before window start, more recent — this one wins
      { timestamp: 4600, price: '1.6' },  // now
    ];
    expect(computePriceChange(trades, 4600, 3600)).toBe('100'); // (1.6 - 0.8) / 0.8 * 100
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd be && npx vitest run src/market/aggregate.test.ts`
Expected: FAIL — `computePriceChange` is not exported.

- [ ] **Step 3: Implement**

Add to `be/src/market/aggregate.ts`, alongside the existing
`compute52WeekHighLow`:

```typescript
export function computePriceChange(trades: readonly { timestamp: number; price: string }[], nowSeconds: number, windowSeconds: number): string | null {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const latestAtOrBefore = (boundary: number): string | null => {
    let result: string | null = null;
    for (const trade of sorted) {
      if (trade.timestamp > boundary) break;
      result = trade.price;
    }
    return result;
  };
  const current = latestAtOrBefore(nowSeconds);
  const past = latestAtOrBefore(nowSeconds - windowSeconds);
  if (current === null || past === null) return null;
  const currentNum = Number(current);
  const pastNum = Number(past);
  if (pastNum === 0) return null;
  const change = ((currentNum - pastNum) / pastNum) * 100;
  return String(change);
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd be && npx vitest run src/market/aggregate.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add be/src/market/aggregate.ts be/src/market/aggregate.test.ts
git commit -m "feat: add computePriceChange for 1H/1D launch price change"
```

---

### Task 6: API — serve the new fields

**Files:**
- Modify: `be/src/api/store.ts`
- Modify: `be/src/api/server.ts`
- Modify: `be/src/api/schemas.ts`
- Test: `be/src/api/store.integration.test.ts`
- Regenerate: `be/openapi.json` (via `npm run openapi:write`)
- Regenerate: `fe/src/api/schema.ts` (via `npm run generate:schema`)

**Interfaces:**
- Consumes: `computePriceChange` (Task 5), the `launches` columns from
  Tasks 2–4.
- Produces: `LaunchSummary` (in `server.ts`) gains
  `logoUri: string | null; description: string | null; websiteUrl: string | null; twitterUrl: string | null; launchTimestamp: string | null; change1h: string | null; change1d: string | null`
  (`launchTimestamp` as a string to match this project's existing
  convention of stringifying numeric API fields — check how `officialVolume24h`/
  `fdvUsd` are typed in the same interface and match it exactly).

- [ ] **Step 1: Write the failing integration test**

In `be/src/api/store.integration.test.ts`, inside the existing
`describe('new stats fields degrade per-launch, not per-page (Review Focus)')`
block (reuse its `goodToken`/`statsSource` fixtures), add:

```typescript
it('returns real logo/description/website/twitter/launchTimestamp from the launches row, with no RPC call', async () => {
  await pool.query(`UPDATE launches SET logo_uri=$1, description=$2, website_url=$3, twitter_url=$4, launch_timestamp=$5 WHERE token_address=$6`,
    ['ipfs://bafkreitest', 'A real token', 'https://example.com', 'https://x.com/example', 1_700_000_000, goodToken]);
  try {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 269170223591n, 1790859457n, 1790859457n, 1n];
      if (functionName === 'totalSupply') return 1_000_000n * 10n ** 18n;
      throw new Error(`unexpected ${functionName}`);
    });
    const storeWithRpc = createApiStore(pool, { readContract });
    const detail = await storeWithRpc.getLaunch(4663, goodToken);
    expect(detail?.logoUri).toBe('ipfs://bafkreitest');
    expect(detail?.description).toBe('A real token');
    expect(detail?.websiteUrl).toBe('https://example.com');
    expect(detail?.twitterUrl).toBe('https://x.com/example');
    expect(detail?.launchTimestamp).toBe('1700000000');
  } finally {
    await pool.query(`UPDATE launches SET logo_uri=NULL, description=NULL, website_url=NULL, twitter_url=NULL, launch_timestamp=NULL WHERE token_address=$1`, [goodToken]);
  }
});

it('returns null extended-metadata fields for a launch that never had them indexed', async () => {
  const storeWithRpc = createApiStore(pool, { readContract: vi.fn() });
  const detail = await storeWithRpc.getLaunch(4663, goodToken);
  expect(detail?.logoUri).toBeNull();
  expect(detail?.description).toBeNull();
  expect(detail?.websiteUrl).toBeNull();
  expect(detail?.twitterUrl).toBeNull();
  expect(detail?.launchTimestamp).toBeNull();
});

it('computes a real change1h/change1d from official trades, and null for a launch with none', async () => {
  const storeWithRpc = createApiStore(pool, { readContract: vi.fn() });
  const detail = await storeWithRpc.getLaunch(4663, goodToken);
  // goodToken's beforeAll fixture seeds exactly one trade "now" — one trade alone can't
  // produce a non-null change1h/1d (no trade exists one window further back).
  expect(detail?.change1h).toBeNull();
  expect(detail?.change1d).toBeNull();
});
```

Read `store.integration.test.ts`'s actual `goodToken` fixture setup first
(what trades it seeds and when) before asserting the exact change1h/1d
expectation — adjust the third test's assertion to match whatever that
fixture actually produces (seed an explicit second older trade in this test
if the fixture doesn't already have one one-window-back, to get a real
non-null case alongside the null case).

- [ ] **Step 2: Run to verify failure**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts`
Expected: FAIL — `detail?.logoUri` is `undefined` (field doesn't exist on
the returned object yet).

- [ ] **Step 3: Add the fields to `LaunchSummary` and `summary()`**

In `be/src/api/server.ts`'s `LaunchSummary` interface, add the seven new
fields listed in this task's Interfaces block.

In `be/src/api/store.ts`'s `summary()` function (the one building the
`LaunchSummary` object from a DB row), add:

```typescript
    logoUri: row.logoUri ?? null,
    description: row.description ?? null,
    websiteUrl: row.websiteUrl ?? null,
    twitterUrl: row.twitterUrl ?? null,
    launchTimestamp: row.launchTimestamp === null ? null : String(row.launchTimestamp),
```

(Match this file's existing Drizzle row-field casing — confirm whether
Drizzle returns `row.logoUri` or `row.logo_uri` for this project's
configured casing convention by checking how an adjacent existing column,
e.g. `row.lifecycleStatus`, is referenced in the same function, and use the
same convention.)

- [ ] **Step 4: Add `change1h`/`change1d` computation**

In `be/src/api/store.ts`'s `computeStats`, the 52-week query (~lines 102-104)
currently selects only `price_numerator_raw`/`price_denominator_raw` — add
`t.timestamp` to its `SELECT` list, since `computePriceChange` needs each
trade's own timestamp, not just its price:

```typescript
    const highLowResult = await pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp FROM trades t JOIN venues v ON v.id = t.venue_id
      WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true AND t.timestamp >= $3
        AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL`, [number(row.chain_id), string(row.token_address), since]);
```

Then, after the existing `prices`/`{ high, low }` lines (~lines 105-107),
add:

```typescript
    const pricedTrades = (highLowResult.rows as Row[]).map((r) => ({
      timestamp: number(r.timestamp),
      price: formatRational(BigInt(string(r.price_numerator_raw)), BigInt(string(r.price_denominator_raw)), 18),
    }));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const change1h = computePriceChange(pricedTrades, nowSeconds, 3600);
    const change1d = computePriceChange(pricedTrades, nowSeconds, 86400);
```

and add `change1h, change1d` to this function's final `return { fdvUsd, marketCapUsd: fdvUsd, week52High: high, week52Low: low, ...tvl }`
statement (~line 109). Also add `change1h: string | null; change1d: string | null`
to the `StatsFields` interface (~line 57:
`interface StatsFields extends TvlFields { fdvUsd: string | null; marketCapUsd: string | null; week52High: string | null; week52Low: string | null }`)
and to `NULL_STATS` (~line 58:
`const NULL_STATS: StatsFields = { fdvUsd: null, marketCapUsd: null, week52High: null, week52Low: null, ...NULL_TVL }`
— add `change1h: null, change1d: null` to this object literal), so the
`!rpcClient || !complete` early-return path and the `catch` block both
correctly return `null` for these two fields too. Import `computePriceChange`
from `../market/aggregate.js`. Add the same two fields to the
`LaunchSummary` interface in `be/src/api/server.ts` alongside
`week52High`/`week52Low`.

- [ ] **Step 5: Update `schemas.ts`**

In `be/src/api/schemas.ts`, add the seven new fields (all
`{ type: 'string', nullable: true }` except `logoUri`/`description`/
`websiteUrl`/`twitterUrl` which are also `{ type: 'string', nullable: true }`)
to the launch-summary OpenAPI schema object, matching the existing
`fdvUsd`/`week52High` entries' style exactly.

- [ ] **Step 6: Run to verify the integration tests pass**

Run: `cd be && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npx vitest run src/api/store.integration.test.ts`
Expected: PASS, all 3 new tests plus every pre-existing test in the file.

- [ ] **Step 7: Regenerate OpenAPI and FE schema**

Run: `cd be && npm run openapi:write && cd ../fe && npm run generate:schema`
Expected: `be/openapi.json` and `fe/src/api/schema.ts` both show diffs
containing the seven new fields; `cd be && npm run openapi:check` passes
afterward (confirms the committed file matches what the server actually
serves).

- [ ] **Step 8: Run the full backend and frontend verification**

Run: `cd be && npm test && npx tsc --noEmit && npm run lint && npm run build && cd ../fe && npx tsc --noEmit && npm run lint && npm run check:schema`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add be/src/api/store.ts be/src/api/server.ts be/src/api/schemas.ts be/src/api/store.integration.test.ts be/openapi.json fe/src/api/schema.ts
git commit -m "feat: serve logo/description/website/twitter/launchTimestamp/change1h/change1d from the API"
```

---

### Task 7: FE list table — Uniswap column layout

**Files:**
- Modify: `fe/src/features/launches/launch-list.tsx`
- Create: `fe/src/api/ipfs.ts`
- Test: `fe/src/api/ipfs.test.ts`
- Test: `fe/src/features/launches/launch-list.test.tsx`

**Interfaces:**
- Consumes: `LaunchSummary`'s new fields (Task 6), `listSources()`'s
  existing `/v1/sources` data (already in `fe/src/api/client.ts`).
- Produces: `export function resolveLogoUrl(uri: string | null): string | null`
  in `fe/src/api/ipfs.ts` — used by both this task and Task 8.

- [ ] **Step 1: Write the failing IPFS-resolution test**

```typescript
import { describe, expect, it } from 'vitest';
import { resolveLogoUrl } from './ipfs.js';

describe('resolveLogoUrl', () => {
  it('resolves an ipfs:// URI through the Pinata gateway', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu'))
      .toBe('https://gateway.pinata.cloud/ipfs/bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu');
  });

  it('passes a non-ipfs:// URL through unchanged', () => {
    expect(resolveLogoUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
  });

  it('returns null for a null input', () => {
    expect(resolveLogoUrl(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd fe && npx vitest run src/api/ipfs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// Pinata is the only publicly-reachable IPFS gateway verified working against a real token logo
// this session — ipfs.io returned 429 (rate-limited), cloudflare-ipfs.com's DNS no longer
// resolves at all. Do not add either without re-verifying.
const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

export function resolveLogoUrl(uri: string | null): string | null {
  if (uri === null) return null;
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice('ipfs://'.length);
  return uri;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd fe && npx vitest run src/api/ipfs.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Write the failing list-table test**

In `fe/src/features/launches/launch-list.test.tsx`, extend the existing
fixture launch object(s) with the new fields and add assertions for the new
columns — read the existing test file first to match its exact fixture
shape and rendering-assertion style (likely `screen.getByText`/
`getByRole('row')` queries), then add:

```typescript
it('renders FDV, 24H volume, Liquidity, 1H%, 1D%, and Age columns with real values', () => {
  // render with a fixture launch carrying real fdvUsd/officialVolume24h/tvlUsd/change1h/change1d/launchTimestamp
  // assert each value renders in its own column
});

it('renders a dash for null 1H/1D change instead of 0% or blank', () => {
  // render with change1h: null, change1d: null
  // assert the rendered text is '—', not '0%' or empty
});

it('falls back to a placeholder avatar when logoUri is null', () => {
  // render with logoUri: null
  // assert a placeholder element renders (e.g. the symbol's first letter), not a broken <img>
});

it('hides the row-specific logo image and shows the placeholder when the image fails to load', () => {
  // render with a real logoUri, fire the <img>'s onError handler, assert the placeholder now shows
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd fe && npx vitest run src/features/launches/launch-list.test.tsx`
Expected: FAIL — new columns/behavior don't exist yet.

- [ ] **Step 7: Redesign the table**

Rewrite `fe/src/features/launches/launch-list.tsx`'s table markup to the
column set from the spec: `#`, `Token` (image from `resolveLogoUrl(launch.logoUri)`
with `onError` swapping to a placeholder — first letter of `launch.symbol`
on a colored circle — plus a small Robinhood Chain logo badge absolutely
positioned over the token logo's bottom-right corner), `Launchpad` (small
platform icon + `launch.platform`), `FDV`, `24H volume`, `Liquidity`, `1H %`
and `1D %` (render `change1h`/`change1d` as `${value}%` with a green class
for a positive numeric value and red for negative, `—` for `null`), `Age`
(compute from `launch.launchTimestamp`: `null` → `—`, otherwise a relative
string like "80d" — write a small local helper, do not add a date library
dependency for this).

Add tabs `All` / `Recently launched` / `Trending` above the existing
search/filter form — `Recently launched` keeps the existing default sort
(already by launch recency), `Trending` sorts the current page's items by
`change1h` descending with `null` values last (client-side sort over
`page.items`, since this reuses already-fetched data — no new API query
parameter). Add a `Launchpad` `<select>` populated from the `sources` prop
already passed into this component (dedupe by `platform`), wired through
`filterHref`'s existing querystring-building pattern alongside the
existing `status` filter. Render the chain logo next to the existing chain
list purely as a label (not a working filter) — do not add a `chainId`
option the existing `chainIds.length > 1` branch doesn't already support
meaningfully differently than today.

- [ ] **Step 8: Run to verify the list-table tests pass**

Run: `cd fe && npx vitest run src/features/launches/launch-list.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the full frontend suite, typecheck, lint, build**

Run: `cd fe && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 10: Manually verify in a browser**

Start `npm run dev:api -w be` and `npm run dev -w fe`, open
`http://localhost:3000`, confirm: columns render, a known real launch with
indexed metadata (if any exist in the dev DB after Tasks 3/4 have run
against live data) shows a real logo via the Pinata gateway, a launch
without metadata shows the placeholder avatar, `null` 1H/1D cells show `—`
not `0%`.

- [ ] **Step 11: Commit**

```bash
git add fe/src/features/launches/launch-list.tsx fe/src/api/ipfs.ts fe/src/api/ipfs.test.ts fe/src/features/launches/launch-list.test.tsx
git commit -m "feat: redesign launch list table to Uniswap's column layout"
```

---

### Task 8: FE detail page — About section

**Files:**
- Modify: `fe/src/features/launch/launch-detail.tsx`
- Test: `fe/src/features/launch/launch-detail.test.tsx`

**Interfaces:**
- Consumes: `LaunchSummary`'s new fields (Task 6), `resolveLogoUrl`
  (Task 7).
- Produces: nothing further consumed by other tasks — this is the plan's
  last task.

- [ ] **Step 1: Write the failing tests**

In `fe/src/features/launch/launch-detail.test.tsx`, extend the existing
detail fixture and add:

```typescript
it('renders the About section with description, truncated with Show more when long', () => {
  // fixture with a long description (over whatever truncation threshold the implementation picks, e.g. 200 chars)
  // assert the visible text is truncated and a "Show more" control exists
  // click it, assert the full description now renders
});

it('hides the About section description entirely when null', () => {
  // fixture with description: null
  // assert no description text/placeholder renders
});

it('always renders the token address and Robinhood Explorer pills', () => {
  // assert a pill linking to `https://robinhoodchain.blockscout.com/token/${tokenAddress}` exists
  // assert a copy-to-clipboard control exists for the address
});

it('hides the Website pill when websiteUrl is null, and the Twitter pill when twitterUrl is null', () => {
  // fixture with websiteUrl: null, twitterUrl: 'https://x.com/example'
  // assert no "Website" pill renders; the "Twitter" pill does, linking to the real URL
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: FAIL — About section doesn't exist yet.

- [ ] **Step 3: Implement the About section**

Add to `fe/src/features/launch/launch-detail.tsx`: a new section rendering
`detail.description` (if non-null) with a truncate/"Show more" toggle
(local `useState<boolean>` for expanded/collapsed — this is a Client
Component concern; if `launch-detail.tsx` is currently a Server Component,
extract this specific piece into a small new Client Component, e.g.
`fe/src/features/launch/about-section.tsx`, matching how this project
already splits client-interactive pieces out of server pages elsewhere —
check `coverage-badge.tsx` or `trade-list.tsx` for the existing pattern
before deciding). Below it, pill buttons: token address (truncated display,
click-to-copy via `navigator.clipboard.writeText`), an always-rendered
"Robinhood Explorer" link to
`` `https://robinhoodchain.blockscout.com/token/${detail.tokenAddress}` ``,
a "Website" pill linking to `detail.websiteUrl` rendered only when non-null,
a "Twitter" pill linking to `detail.twitterUrl` rendered only when
non-null.

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd fe && npx vitest run src/features/launch/launch-detail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite, typecheck, lint, build, and e2e**

Run: `cd fe && npm test && npx tsc --noEmit && npm run lint && npm run build && npm run test:e2e`
Expected: all green, including the existing e2e specs (confirms the detail
page redesign didn't break `fe/e2e/launch-detail.spec.ts`'s existing
assertions — read that file first if anything fails, and update its
selectors to match the new markup rather than loosening its assertions).

- [ ] **Step 6: Manually verify in a browser**

Confirm the About section renders correctly for a launch with full
metadata and for one with none, and that clicking the address pill copies
it (check via the browser's clipboard permission prompt or a visible
"Copied" confirmation, whichever this project's existing copy-button
pattern elsewhere already uses — check if one already exists before
inventing a new one).

- [ ] **Step 7: Commit**

```bash
git add fe/src/features/launch/launch-detail.tsx fe/src/features/launch/launch-detail.test.tsx
git commit -m "feat: add About section to launch detail page (description, address, explorer, website, twitter)"
```
