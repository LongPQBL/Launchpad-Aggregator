# Envio HyperIndex Migration — Phase 1 (Pons V1 legacy + V3 pool slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a self-hosted Envio HyperIndex project that indexes Pons V1-legacy `TokenLaunched` events and the official V3 pool `Swap` events it discovers via `contractRegister`, then reimplement the existing business logic in a new sync layer that writes into staging tables mirroring the app's real schema, verified end-to-end against the project's existing `pons-v1-reference.json` fixture.

**Architecture:** `envio/` is a new, standalone, self-hosted Envio project (its own `docker-compose.yaml`, its own Postgres, on ports that do not collide with the app's own `compose.yaml`). It writes minimally-transformed raw entities. A new `be/src/envioSync/` module (inside the existing `be` app, reusing its existing TypeScript/Vitest/Drizzle tooling and its existing pure business-logic functions where the shapes line up) reads Envio's Postgres directly with a plain `pg` client and writes into new `*_envio_staging` tables added via an additive Drizzle migration — never into the real `launches`/`venues`/`trades` tables. A comparison CLI reports how the staging tables compare to the real ones for the same source/range.

**Tech Stack:** Envio HyperIndex (self-hosted, TypeScript handlers), Docker Compose, Node.js >=24, TypeScript, Drizzle, `pg`, Vitest — all matching the existing `be/` toolchain; no new toolchain inside `be/`.

**Spec:** `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md`

## Global Constraints

- Self-hosted Envio only (not Envio Cloud) — per spec section 1 and CLAUDE.md's local-first preference.
- Keep the existing PostgreSQL/Drizzle schema, Fastify API, and frontend completely unchanged in this phase — per spec section 1/9. This plan never modifies `be/src/db/schema.ts`'s existing tables, only adds new staging tables.
- Only Pons V1-legacy `TokenLaunched` → V3 pool `Swap` in this phase — per spec section 8 step 1 ("V1 legacy + V3 pool trước"). V2 curve/lifecycle, V4 verification, the real parallel-run comparison against the live indexer, and cutover are explicitly out of scope for this plan (separate follow-on plans, per spec section 8 steps 2–7).
- Addresses stored lowercase; exact `(blockNumber, logIndex)` ordering and raw integer amounts preserved — per CLAUDE.md and the existing `be/src/db/repository.ts` convention (see `persistBatchInTransaction`).
- Never fabricate data: a dust swap where either leg decodes to exactly zero is a real on-chain event, not an error — treat it as no-trade (`null`), exactly like `decodeV1Swap` already does (`be/src/launchpads/pons/v1/adapter.ts:114`).
- Frontend copy/docs stay Vietnamese; code identifiers, tests, comments, API fields, filenames stay English — per CLAUDE.md.
- Node.js >=24 — per CLAUDE.md and `be/package.json`'s `engines`.
- Do not commit `ENVIO_API_TOKEN`, RPC URLs with keys, or any other secret — follow the existing `.env`/`.env.example` convention (`be/.env.example`).

## Review Focus

- **Mixed-up factory provenance for a dynamically-registered V3 pool.** `pons-v1-legacy` and `pons-v1-active` are two different factories on the same chain; this phase only wires up `pons-v1-legacy`, but a `contractRegister` handler that isn't scoped correctly could register a pool from the wrong context or double-register the same pool across passes. Task 3's test pins that only a pool discovered via the legacy factory's `TokenLaunched` is registered.
- **Address case mismatches.** Envio may emit checksummed or mixed-case hex for addresses; the app's real tables and this plan's staging tables both assume lowercase (`be/src/db/repository.ts:240` etc.). Task 2 and Task 3's handler tests assert the raw entity stores lowercase addresses.
- **Dust-swap silent divergence.** The reimplemented swap-to-trade math in the sync layer must reject/null a dust swap exactly like `decodeV1Swap` does, not silently emit a zero-amount trade. Task 4's cross-check test reuses this project's own dust-swap fixture values (from `README.md`'s "Hai vấn đề khiến nguồn trade v1 kẹt vĩnh viễn" entry) to confirm identical behavior.
- **Non-WETH quote asset silently accepted.** `hydrateV1Launch` throws when `pairToken !== WETH` (`be/src/launchpads/pons/v1/adapter.ts:66`); the sync layer must preserve and re-check this, not skip it because Envio already "decoded" the event. Task 4 pins this.
- **Non-idempotent re-sync creating duplicate staging rows.** The sync layer will be re-run repeatedly against a moving Envio database; Task 5's integration test runs the sync twice over the same Envio rows and asserts the staging tables end up with the same row count, not doubled.

---

## Task 1: Scaffold a self-hosted Envio project and prove the toolchain runs

**Files:**
- Create: `envio/` (copied from the `enviodev/local-docker-example` reference repository, then trimmed)
- Create: `envio/.env.example`
- Modify: root `.gitignore`
- Modify: root `README.md` (new short section pointing at `envio/`)

**Interfaces:**
- Consumes: nothing from this repo.
- Produces: a running `docker compose` stack (Envio's own Postgres + Hasura GraphQL engine + the indexer process) that later tasks build on. Records the actual, observed values for: Envio Postgres host/port/user/password/database name, the Postgres schema Envio writes raw entities into (default `envio`, via `ENVIO_PG_PUBLIC_SCHEMA`), and where `ENVIO_API_TOKEN` is supplied — Task 2 onward use these exact values, not assumed ones.

This task deliberately proves the Docker/Envio/HyperSync toolchain works using the reference example's own unmodified contract config, before any Pons-specific config is introduced in Task 2 — so a failure here is isolated to tooling, not to our own YAML/handler code.

- [ ] **Step 1: Obtain a free Envio API token (user action — cannot be automated)**

Self-hosted Envio still requires a free `ENVIO_API_TOKEN` for HyperSync access (confirmed in this session's research: mandatory since 2025-11-03 for any deployment that isn't Envio-Cloud-hosted). Creating an account is outside what this plan's executor can do on the user's behalf. Ask the user to sign up at envio.dev, generate a token, and hand it back before continuing past Step 5 below. Do not proceed to Step 5 without it.

- [ ] **Step 2: Copy the reference self-hosted example as the starting scaffold**

```bash
git clone --depth 1 https://github.com/enviodev/local-docker-example /tmp/envio-reference
mkdir -p envio
cp -r /tmp/envio-reference/. envio/
rm -rf envio/.git /tmp/envio-reference
```

Expected: `envio/` now contains (among other files) `docker-compose.yaml`, a `Dockerfile`, `config.yaml`, `schema.graphql`, and a handler source file (`src/EventHandlers.ts` or similar) copied verbatim from the reference example.

- [ ] **Step 3: Read the copied compose file to learn the real service shape**

```bash
cat envio/docker-compose.yaml
```

Expected: real output showing three services — an `envio-postgres` (or similarly named) Postgres container, a `graphql-engine` (Hasura) container, and an `envio-indexer` container built from the local `Dockerfile`. Note the exact: Postgres image/port/user/password/database name, the Hasura port, the indexer port, and every environment variable each service reads (in particular anything named `ENVIO_API_TOKEN`, `ENVIO_PG_PUBLIC_SCHEMA`, or similar — if `ENVIO_API_TOKEN` is not already wired into the `envio-indexer` service's `environment:` block, add it there, sourced from `envio/.env`). Confirm none of the ports collide with the app's own `compose.yaml` (`127.0.0.1:55432` for the app's Postgres).

- [ ] **Step 4: Create `envio/.env.example` and `envio/.env`**

`envio/.env.example` (committed):
```
# Free token from https://envio.dev — required even for self-hosted deployments (HyperSync access).
ENVIO_API_TOKEN=
```

`envio/.env` (gitignored, real value from Step 1):
```
ENVIO_API_TOKEN=<token from envio.dev>
```

- [ ] **Step 5: Add `envio/.env` to `.gitignore`**

Add to the root `.gitignore` (alongside the existing `.env`/`.env.local` entries):

```
envio/.env
envio/generated/
```

- [ ] **Step 6: Bring the stack up using the reference example's own unmodified config**

```bash
cd envio && docker compose up -d --build
```

Expected: `docker compose ps` (still inside `envio/`) shows all three containers in an `Up`/healthy state within about 60 seconds. This proves Docker, the Envio image, and `ENVIO_API_TOKEN` all work together before any Pons-specific code is written.

- [ ] **Step 7: Inspect the real raw-entity table Envio created for the reference example**

```bash
docker compose exec envio-postgres psql -U <user from Step 3> -d <db from Step 3> -c "\dn"
docker compose exec envio-postgres psql -U <user from Step 3> -d <db from Step 3> -c "\dt <schema from \dn output>.*"
```

Expected: `\dn` lists a schema (default name `envio`, overridable via `ENVIO_PG_PUBLIC_SCHEMA` — confirm which applies here). `\dt` lists one table per GraphQL entity the reference example's `schema.graphql` declares. Record the exact table-naming convention observed (e.g. `"RawLaunch"` quoted mixed-case vs. `raw_launch` snake_case) — Task 2 Step 7 and Task 5 depend on this exact convention.

- [ ] **Step 8: Stop the stack before replacing its config in Task 2**

```bash
docker compose down
```

(Volumes persist; Task 2 restarts with Pons-specific config.)

- [ ] **Step 9: Commit**

```bash
git add envio/ .gitignore
git commit -m "chore: scaffold self-hosted Envio project from the reference example

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Pons V1-legacy `TokenLaunched` → `RawLaunch` entity

**Files:**
- Modify: `envio/config.yaml`
- Modify: `envio/schema.graphql`
- Modify: `envio/src/EventHandlers.ts` (or the filename observed in Task 1 Step 2 — use that real filename)

**Interfaces:**
- Consumes: the real Postgres connection details and schema/table-naming convention recorded in Task 1 Steps 3 and 7.
- Produces: an Envio Postgres table holding one row per `TokenLaunched` event from the `pons-v1-legacy` factory (`0x0c37a24F5D23A486FA692d1500881d698B1F77a4`, chain `4663`, start block `8600612` — same values as `be/src/launchpads/pons/sourceRegistry.ts`), with columns: `id`, `chainId`, `tokenAddress`, `deployerAddress`, `pairTokenAddress`, `poolAddress`, `blockNumber`, `blockHash`, `txHash`, `logIndex` — Task 4's transform function consumes exactly this shape (mapped 1:1 from the existing `V1LaunchEvent` interface in `be/src/launchpads/pons/v1/adapter.ts:19-29`, minus `sourceLogId` which the sync layer derives itself).

- [ ] **Step 1: Replace `envio/config.yaml`**

```yaml
name: pons-envio-indexer
contracts:
  - name: PonsV1LegacyFactory
    handler: src/EventHandlers.ts
    events:
      - event: "TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)"
chains:
  - id: 4663
    rpc: https://robinhood.hypersync.xyz
    start_block: 8600612
    contracts:
      - name: PonsV1LegacyFactory
        address:
          - "0x0c37a24F5D23A486FA692d1500881d698B1F77a4"
```

- [ ] **Step 2: Replace `envio/schema.graphql`**

```graphql
type RawLaunch {
  id: ID!
  chainId: Int!
  tokenAddress: String!
  deployerAddress: String!
  pairTokenAddress: String!
  poolAddress: String!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
}
```

- [ ] **Step 3: Replace the handler file's contents**

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "PonsV1LegacyFactory", event: "TokenLaunched" },
  async ({ event, context }) => {
    context.RawLaunch.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      deployerAddress: event.params.deployer.toLowerCase(),
      pairTokenAddress: event.params.pairToken.toLowerCase(),
      poolAddress: event.params.pool.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);
```

- [ ] **Step 4: Run codegen and fix any type errors against real compiler output**

```bash
cd envio && pnpm install && pnpm codegen
```

Expected: codegen completes. If it reports `event.block.hash` or `event.transaction.hash` as missing/untyped, open the generated types under `envio/generated/` to find the exact `field_selection` key Envio's current version expects, add it under `chains[0].contracts[0]` (or per-event, per whatever the generated types indicate) in `config.yaml`, and re-run `pnpm codegen` until it succeeds. This is a real, checkable compiler loop — do not guess past what the generated types show.

- [ ] **Step 5: Start the indexer against the real chain**

```bash
docker compose up -d --build
```

- [ ] **Step 6: Wait until indexing has passed the fixture's launch block, then stop**

The fixture launch (`be/tests/fixtures/pons-v1-reference.json`) is at block `8963150` (hex `0x88c44e`). Poll the indexer's own progress (its logs, or Hasura at the port recorded in Task 1 Step 3) until it reports a block number at or above `8963150`, then:

```bash
docker compose stop envio-indexer
```

Expected: the indexer's logs show it processed at least one `TokenLaunched` event before stopping (this factory has real launches long before this block — see `be/src/launchpads/pons/sourceRegistry.ts`'s `startBlock: 8600612n`).

- [ ] **Step 7: Verify the exact fixture launch landed in Envio's Postgres**

```bash
docker compose exec envio-postgres psql -U <user> -d <db> -c \
  "SELECT \"tokenAddress\", \"deployerAddress\", \"pairTokenAddress\", \"poolAddress\", \"blockNumber\", \"txHash\", \"logIndex\" FROM <schema>.<RawLaunch table name from Task 1 Step 7> WHERE \"txHash\" = '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8';"
```

Expected: exactly one row, with `tokenAddress = '0x39dbed3a2bd333467115de45665cc57f813c4571'`, `poolAddress = '0x10cc6bd38112cac182db90b6a71d8bb5939526ba'`, `pairTokenAddress = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'`, `blockNumber = 8963150`, `logIndex = 45` (`0x2d`) — these are the exact values in `be/tests/fixtures/pons-v1-reference.json`'s `launch` block, decoded independently by Envio instead of by this repo's own `decodeV1Launch`. A match here is the first real cross-implementation confirmation that Envio decodes Pons V1 launches correctly.

- [ ] **Step 8: Commit**

```bash
git add envio/config.yaml envio/schema.graphql envio/src/
git commit -m "feat: index Pons V1-legacy TokenLaunched via Envio, verified against the fixture launch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Dynamically register the V3 pool and index its official `Swap` events

**Files:**
- Modify: `envio/config.yaml`
- Modify: `envio/schema.graphql`
- Modify: `envio/src/EventHandlers.ts`

**Interfaces:**
- Consumes: the `PonsV1LegacyFactory`/`TokenLaunched` handler from Task 2 (adds a `contractRegister` alongside it).
- Produces: an Envio Postgres table holding one row per `Swap` event from every pool discovered this way, columns: `id`, `chainId`, `poolAddress`, `sender`, `recipient`, `amount0`, `amount1`, `sqrtPriceX96`, `liquidity`, `tick`, `blockNumber`, `blockHash`, `txHash`, `logIndex`, `timestamp` — Task 4's swap transform function consumes exactly this shape.

- [ ] **Step 1: Add the dynamically-registered contract and its event to `config.yaml`**

Extend the `contracts:` and `chains[0].contracts:` blocks from Task 2 (full file, replacing Task 2's version):

```yaml
name: pons-envio-indexer
contracts:
  - name: PonsV1LegacyFactory
    handler: src/EventHandlers.ts
    events:
      - event: "TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)"
  - name: PonsV3Pool
    handler: src/EventHandlers.ts
    events:
      - event: "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
chains:
  - id: 4663
    rpc: https://robinhood.hypersync.xyz
    start_block: 8600612
    contracts:
      - name: PonsV1LegacyFactory
        address:
          - "0x0c37a24F5D23A486FA692d1500881d698B1F77a4"
      - name: PonsV3Pool
```

`PonsV3Pool` has no `address:` under `chains[0].contracts` — this is what makes it a dynamically-registered contract instead of a statically-configured one.

- [ ] **Step 2: Add the `RawSwap` entity to `schema.graphql`** (append to the `RawLaunch` type from Task 2)

```graphql
type RawSwap {
  id: ID!
  chainId: Int!
  poolAddress: String!
  sender: String!
  recipient: String!
  amount0: BigInt!
  amount1: BigInt!
  sqrtPriceX96: BigInt!
  liquidity: BigInt!
  tick: Int!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
  timestamp: Int!
}
```

- [ ] **Step 3: Add `contractRegister` and the `Swap` handler** (append to the handler file from Task 2)

```typescript
indexer.contractRegister(
  { contract: "PonsV1LegacyFactory", event: "TokenLaunched" },
  ({ event, context }) => {
    context.chain.PonsV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "PonsV3Pool", event: "Swap" },
  async ({ event, context }) => {
    context.RawSwap.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolAddress: event.srcAddress.toLowerCase(),
      sender: event.params.sender.toLowerCase(),
      recipient: event.params.recipient.toLowerCase(),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: event.params.tick,
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);
```

If `event.block.timestamp` is missing/untyped, apply the same real-compiler-feedback loop as Task 2 Step 4 (check `envio/generated/`, add the right `field_selection` key, re-run codegen).

- [ ] **Step 4: Codegen, restart from a clean volume, and run past the fixture swap block**

```bash
cd envio && pnpm codegen
docker compose down -v && docker compose up -d --build
```

Wait until the indexer's logs show it has passed block `8963150` again (same wait condition as Task 2 Step 6), confirm it registered at least the fixture's pool (`0x10cc6bd38112cac182db90b6a71d8bb5939526ba`) via `contractRegister`, then:

```bash
docker compose stop envio-indexer
```

- [ ] **Step 5: Verify the exact fixture swap landed in Envio's Postgres**

```bash
docker compose exec envio-postgres psql -U <user> -d <db> -c \
  "SELECT \"poolAddress\", \"amount0\", \"amount1\", \"sqrtPriceX96\", \"blockNumber\", \"txHash\", \"logIndex\" FROM <schema>.<RawSwap table name> WHERE \"txHash\" = '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8';"
```

Expected: exactly one row, `poolAddress = '0x10cc6bd38112cac182db90b6a71d8bb5939526ba'`, `blockNumber = 8963150`, `logIndex = 49` (`0x31`) — matching `be/tests/fixtures/pons-v1-reference.json`'s `swap` block. This is the second real cross-implementation confirmation: the pool was discovered purely from `contractRegister` (never hand-listed), and its `Swap` event decoded correctly.

- [ ] **Step 6: Commit**

```bash
git add envio/config.yaml envio/schema.graphql envio/src/
git commit -m "feat: dynamically register V3 pools and index their Swap events via Envio contractRegister

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Sync-layer transform functions (pure, no DB)

**Files:**
- Create: `be/src/envioSync/transformV1Legacy.ts`
- Create: `be/src/envioSync/transformV1Legacy.test.ts`

**Interfaces:**
- Consumes: `hydrateV1Launch` from `be/src/launchpads/pons/v1/adapter.ts` (reused as-is, unchanged); `V1LaunchEvent`, `V1TokenMetadata`, `LaunchWithVenue` types from the same file; `Trade`, `Launch`, `Venue` from `be/src/domain/types.js`; `logKey`, `venueKey` from `be/src/domain/ids.js`; the `FactorySource` for `pons-v1-legacy` from `be/src/launchpads/pons/sourceRegistry.js`.
- Produces: `envioRawLaunchToEvent(row: EnvioRawLaunchRow): V1LaunchEvent` and `hydrateV1SwapFromDecoded(row: EnvioRawSwapRow, venue: Venue, launch: Launch, traderAddress: Address): Trade | null` — Task 5's sync script consumes both exactly.

- [ ] **Step 1: Write the failing cross-check test for the launch-event mapper**

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { decodeV1Launch, hydrateV1Launch, type RpcLog } from '../launchpads/pons/v1/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { envioRawLaunchToEvent, type EnvioRawLaunchRow } from './transformV1Legacy.js';

const reference = JSON.parse(readFileSync(new URL('../../../tests/fixtures/pons-v1-reference.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const legacy = getPonsFactorySources()[0];

function asLog(raw: Record<string, unknown>): RpcLog {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as string),
    blockHash: raw.blockHash as Hash,
    transactionHash: (raw.transactionHash ?? raw.txHash) as Hash,
    logIndex: Number(raw.logIndex),
  };
}

describe('envioRawLaunchToEvent', () => {
  it('produces the same V1LaunchEvent as decoding the raw log directly', () => {
    const expected = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const row: EnvioRawLaunchRow = {
      chainId: 4663,
      tokenAddress: reference.tokenAddress as string,
      deployerAddress: '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
      pairTokenAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      poolAddress: reference.poolAddress as string,
      blockNumber: 8963150n,
      blockHash: (reference.launch as Record<string, unknown>).blockHash as string,
      txHash: '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8',
      logIndex: 45,
    };
    const event = envioRawLaunchToEvent(row);
    expect(event).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformV1Legacy.test.ts`
Expected: FAIL — `Cannot find module './transformV1Legacy.js'` (file does not exist yet).

- [ ] **Step 3: Write `envioRawLaunchToEvent`**

```typescript
import type { Address, Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import type { V1LaunchEvent } from '../launchpads/pons/v1/adapter.js';

export interface EnvioRawLaunchRow {
  chainId: number;
  tokenAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  poolAddress: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export function envioRawLaunchToEvent(row: EnvioRawLaunchRow): V1LaunchEvent {
  return {
    tokenAddress: row.tokenAddress.toLowerCase() as Address,
    deployerAddress: row.deployerAddress.toLowerCase() as Address,
    pairToken: row.pairTokenAddress.toLowerCase() as Address,
    poolAddress: row.poolAddress.toLowerCase() as Address,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash.toLowerCase() as Hash,
    transactionHash: row.txHash.toLowerCase() as Hash,
    logIndex: row.logIndex,
    sourceLogId: logKey(row.chainId, row.blockHash.toLowerCase() as Hash, row.txHash.toLowerCase() as Hash, row.logIndex),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformV1Legacy.test.ts`
Expected: PASS 1/1.

- [ ] **Step 5: Write the failing cross-check test for the swap transform (real trade + dust-swap + non-WETH rejection)**

Append to the same test file:

```typescript
import { decodeV1Swap } from '../launchpads/pons/v1/adapter.js';
import { hydrateV1SwapFromDecoded, type EnvioRawSwapRow } from './transformV1Legacy.js';

const trader = '0x1234567890123456789012345678901234567890' as Address;

describe('hydrateV1SwapFromDecoded', () => {
  it('produces the same Trade as decoding the raw swap log directly', () => {
    const launchEvent = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(launchEvent, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, true);
    const expected = decodeV1Swap(asLog(reference.swap as Record<string, unknown>), venue, launch, 1_700_000_000, trader);
    const row: EnvioRawSwapRow = {
      poolAddress: reference.poolAddress as string,
      sender: '0xcaf681a66d020601342297493863e78c959e5cb2',
      recipient: '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a',
      amount0: 100_000_000_000_000_000n,
      amount1: -68057245261861571047346184n,
      sqrtPriceX96: 2005366647941715384651103712059394n,
      liquidity: 36819258015569838458222n,
      tick: 202790,
      blockNumber: 8963150n,
      blockHash: (reference.swap as Record<string, unknown>).blockHash as string,
      txHash: '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8',
      logIndex: 49,
      timestamp: 1_700_000_000,
    };
    const trade = hydrateV1SwapFromDecoded(row, venue, launch, trader);
    expect(trade).toEqual(expected);
    expect(trade!.side).toBe('buy');
    expect(trade!.quoteAmountRaw).toBe(100_000_000_000_000_000n);
  });

  it('nulls a dust swap where one leg is exactly zero, matching decodeV1Swap', () => {
    const launchEvent = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(launchEvent, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, true);
    const row: EnvioRawSwapRow = {
      poolAddress: reference.poolAddress as string,
      sender: '0xcaf681a66d020601342297493863e78c959e5cb2',
      recipient: '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a',
      amount0: 0n,
      amount1: 25654359n,
      // sqrtPriceX96/liquidity/tick are irrelevant here: hydrateV1SwapFromDecoded returns null as
      // soon as it sees a zero leg, before these fields are ever read.
      sqrtPriceX96: 2005366647941715384651103712059394n,
      liquidity: 36819258015569838458222n,
      tick: 202790,
      blockNumber: 9265305n,
      blockHash: '0x' + '9'.repeat(64),
      txHash: '0xba1e0cde96648343c22aea642b45fccbd4a8d3fdcea940fdc770ad5835b4348f',
      logIndex: 1,
      timestamp: 1_700_000_000,
    };
    expect(hydrateV1SwapFromDecoded(row, venue, launch, trader)).toBeNull();
  });
});
```

The `sender`/`recipient`/`amount0`/`amount1`/`sqrtPriceX96`/`liquidity`/`tick` values above are the real decoded fields of `reference.swap` (`be/tests/fixtures/pons-v1-reference.json`), confirmed by decoding its `data`/`topics` with `decodeEventLog`/`v3SwapEvent` from `be/src/launchpads/pons/v1/abi.ts` — not illustrative placeholders.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformV1Legacy.test.ts`
Expected: FAIL — `hydrateV1SwapFromDecoded` is not exported (function does not exist yet).

- [ ] **Step 7: Write `hydrateV1SwapFromDecoded`**

Append to `be/src/envioSync/transformV1Legacy.ts`:

```typescript
import type { Launch, Trade, Venue } from '../domain/types.js';

export interface EnvioRawSwapRow {
  poolAddress: string;
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

// Mirrors decodeV1Swap's post-decode math exactly (be/src/launchpads/pons/v1/adapter.ts) but takes
// Envio's already-decoded event fields instead of re-decoding a raw log — there is no topics/data to
// decode here, Envio already did that. Kept in lockstep with decodeV1Swap by the cross-check test in
// transformV1Legacy.test.ts, which runs both on the same fixture swap and asserts identical output.
export function hydrateV1SwapFromDecoded(row: EnvioRawSwapRow, venue: Venue, launch: Launch, traderAddress: `0x${string}`): Trade | null {
  if (venue.kind !== 'v3_pool' || !venue.official || row.poolAddress.toLowerCase() !== venue.ref.toLowerCase()) {
    throw new Error('Swap is not from the official V3 pool');
  }
  if (venue.chainId !== launch.chainId || venue.tokenAddress.toLowerCase() !== launch.tokenAddress.toLowerCase()) {
    throw new Error('Venue does not belong to launch');
  }
  const tokenIsToken0 = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase();
  const tokenSigned = tokenIsToken0 ? row.amount0 : row.amount1;
  const pairSigned = tokenIsToken0 ? row.amount1 : row.amount0;
  if (tokenSigned === 0n || pairSigned === 0n) return null;
  if (tokenSigned * pairSigned > 0n) throw new Error('Invalid V3 swap amounts');
  const q192 = 2n ** 192n;
  const sqrtSquared = row.sqrtPriceX96 * row.sqrtPriceX96;
  if (sqrtSquared === 0n) throw new Error('Invalid V3 sqrt price');
  const decimalScale = 10n ** BigInt(launch.tokenDecimals);
  const quoteScale = 10n ** BigInt(launch.quoteAsset.decimals);
  return {
    chainId: launch.chainId,
    tokenAddress: launch.tokenAddress,
    venueId: venue.id,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash.toLowerCase() as `0x${string}`,
    txHash: row.txHash.toLowerCase() as `0x${string}`,
    logIndex: row.logIndex,
    timestamp: row.timestamp,
    side: pairSigned > 0n ? 'buy' : 'sell',
    tokenAmountRaw: tokenSigned < 0n ? -tokenSigned : tokenSigned,
    quoteAmountRaw: pairSigned < 0n ? -pairSigned : pairSigned,
    quoteAssetAddress: launch.quoteAsset.address,
    sourceEvent: 'Swap',
    activityKind: 'user_trade',
    priceNumeratorRaw: tokenIsToken0 ? sqrtSquared * decimalScale : q192 * decimalScale,
    priceDenominatorRaw: tokenIsToken0 ? q192 * quoteScale : sqrtSquared * quoteScale,
    traderAddress: traderAddress.toLowerCase() as `0x${string}`,
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformV1Legacy.test.ts`
Expected: PASS 3/3.

- [ ] **Step 9: Write the failing test for non-WETH quote rejection (reused, not re-derived)**

Append:

```typescript
describe('hydrateV1Launch via envioRawLaunchToEvent', () => {
  it('still rejects a non-WETH pair, exactly like the direct decode path', () => {
    const row: EnvioRawLaunchRow = {
      chainId: 4663,
      tokenAddress: reference.tokenAddress as string,
      deployerAddress: '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
      pairTokenAddress: '0x1111111111111111111111111111111111111111',
      poolAddress: reference.poolAddress as string,
      blockNumber: 8963150n,
      blockHash: (reference.launch as Record<string, unknown>).blockHash as string,
      txHash: '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8',
      logIndex: 45,
    };
    const event = envioRawLaunchToEvent(row);
    expect(() => hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18, liquidityPool: reference.poolAddress as Address,
    }, true)).toThrow(/quote asset/);
  });
});
```

- [ ] **Step 10: Run it to verify it fails, then passes**

Run: `npx vitest run src/envioSync/transformV1Legacy.test.ts`
Expected first: this specific test FAILs only if `envioRawLaunchToEvent` somehow normalized/rejected the pair itself — since Step 3's implementation is a pure passthrough mapping, this test should already PASS once run (it exercises the untouched, already-correct `hydrateV1Launch`, proving the sync layer didn't accidentally weaken that check). Run it; if it fails, the mapper is doing more than mapping — fix it to be a pure passthrough and re-run until PASS 4/4.

- [ ] **Step 11: Commit**

```bash
cd be && git add src/envioSync/
git commit -m "feat: reimplement Pons V1 launch/swap business logic for the Envio sync layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Staging tables and the sync script

**Files:**
- Create: migration via `npm run db:generate -w be` (after Step 1 below) — file name assigned by Drizzle
- Modify: `be/src/db/schema.ts`
- Create: `be/src/envioSync/envioDb.ts`
- Create: `be/src/envioSync/runSync.ts`
- Create: `be/src/envioSync/runSync.integration.test.ts`
- Modify: `be/.env.example`

**Interfaces:**
- Consumes: `envioRawLaunchToEvent`, `hydrateV1SwapFromDecoded`, `EnvioRawLaunchRow`, `EnvioRawSwapRow` from Task 4; `hydrateV1Launch` from `be/src/launchpads/pons/v1/adapter.js`; `createDatabase` from `be/src/db/client.js`; `chunkForInsert` from `be/src/db/chunk.js`.
- Produces: `syncV1LegacyOnce(envioPool: Pool, appDb: Database): Promise<{ launchesWritten: number; tradesWritten: number }>` — Task 6's comparison CLI runs this (indirectly, by inspecting the tables it writes) as part of the manual end-to-end verification.

- [ ] **Step 1: Add the staging tables to `be/src/db/schema.ts`**

Append (mirrors the real `launches`/`venues`/`trades` shape, prefixed `_envio_staging`, no foreign keys to the real tables — this is intentionally an isolated shadow copy):

```typescript
export const launchesEnvioStaging = pgTable('launches_envio_staging', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  name: text('name').notNull(),
  symbol: text('symbol').notNull(),
  tokenDecimals: integer('token_decimals').notNull(),
  platform: text('platform').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deployerAddress: text('deployer_address').notNull(),
  launchBlock: bigint('launch_block', { mode: 'bigint' }).notNull(),
  launchTxHash: text('launch_tx_hash').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  quoteAssetSymbol: text('quote_asset_symbol').notNull(),
  quoteAssetDecimals: integer('quote_asset_decimals').notNull(),
  lifecycleStatus: text('lifecycle_status').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
]);

export const venuesEnvioStaging = pgTable('venues_envio_staging', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  effectiveFromBlock: bigint('effective_from_block', { mode: 'bigint' }).notNull(),
  official: boolean('official').notNull(),
});

export const tradesEnvioStaging = pgTable('trades_envio_staging', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  venueId: text('venue_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  timestamp: integer('timestamp').notNull(),
  side: text('side').notNull(),
  tokenAmountRaw: numeric('token_amount_raw', { precision: 78, scale: 0 }).notNull(),
  quoteAmountRaw: numeric('quote_amount_raw', { precision: 78, scale: 0 }).notNull(),
  activityKind: text('activity_kind').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
]);
```

- [ ] **Step 2: Generate and review the migration**

```bash
cd be && npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` file containing only `CREATE TABLE` statements for the three new tables — no `ALTER`/`DROP` on any existing table (additive-only, per CLAUDE.md's migration rule). Read the generated file to confirm this.

- [ ] **Step 3: Apply it to the test database**

```bash
DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate
```

Expected: migration applies cleanly.

- [ ] **Step 4: Write the failing integration test for `syncV1LegacyOnce`**

```typescript
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { syncV1LegacyOnce } from './runSync.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
// A second, throwaway Postgres schema on the SAME test database stands in for Envio's own Postgres —
// this test only needs rows shaped like Envio's real raw tables (confirmed empirically in Task 1
// Step 7 / Task 2 Step 7), not an actual running Envio stack.
const envioPool = new Pool({ connectionString: databaseUrl });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawLaunch" (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "poolAddress" text, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawSwap" (
    id text primary key, "chainId" int, "poolAddress" text, sender text, recipient text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, liquidity numeric, tick int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
});

beforeEach(async () => {
  await pool.query('TRUNCATE launches_envio_staging, venues_envio_staging, trades_envio_staging');
  await envioPool.query('TRUNCATE envio_fixture."RawLaunch", envio_fixture."RawSwap"');
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('syncV1LegacyOnce', () => {
  it('writes one launch and one trade from matching raw rows, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture."RawLaunch" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['l1', 4663, '0x39dbed3a2bd333467115de45665cc57f813c4571', '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
        '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        '8963150', '0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3',
        '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8', 45],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture."RawSwap" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      ['s1', 4663, '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        '0xcaf681a66d020601342297493863e78c959e5cb2', '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a',
        '100000000000000000', '-68057245261861571047346184', '2005366647941715384651103712059394',
        '36819258015569838458222', 202790, '8963150',
        '0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3',
        '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8', 49, 1_700_000_000],
    );

    const first = await syncV1LegacyOnce(envioPool, db);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1 });
    const launchRows = await db.select().from(launchesEnvioStaging);
    expect(launchRows).toHaveLength(1);
    expect(launchRows[0].tokenAddress).toBe('0x39dbed3a2bd333467115de45665cc57f813c4571');
    const tradeRows = await db.select().from(tradesEnvioStaging);
    expect(tradeRows).toHaveLength(1);
    expect(tradeRows[0].side).toBe('buy');

    const second = await syncV1LegacyOnce(envioPool, db);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0 });
    expect(await db.select().from(launchesEnvioStaging)).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging)).toHaveLength(1);
  });
});
```

These are the same real decoded fixture values used in Task 4 Step 5.

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test:integration -- src/envioSync/runSync.integration.test.ts`
Expected: FAIL — `Cannot find module './runSync.js'`.

- [ ] **Step 6: Write `be/src/envioSync/envioDb.ts`**

```typescript
import type { Pool } from 'pg';

export interface EnvioRawLaunchDbRow {
  id: string;
  chainId: number;
  tokenAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  poolAddress: string;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export interface EnvioRawSwapDbRow {
  id: string;
  chainId: number;
  poolAddress: string;
  sender: string;
  recipient: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

// Table/schema name is empirically confirmed in Task 1 Step 7 / Task 2 Step 7 against a real
// self-hosted Envio deployment; this test-time default targets the throwaway fixture schema used by
// runSync.integration.test.ts.
const RAW_LAUNCH_TABLE = process.env.ENVIO_RAW_LAUNCH_TABLE ?? 'envio_fixture."RawLaunch"';
const RAW_SWAP_TABLE = process.env.ENVIO_RAW_SWAP_TABLE ?? 'envio_fixture."RawSwap"';

export async function readAllRawLaunches(envioPool: Pool): Promise<EnvioRawLaunchDbRow[]> {
  const result = await envioPool.query(`SELECT * FROM ${RAW_LAUNCH_TABLE}`);
  return result.rows as EnvioRawLaunchDbRow[];
}

export async function readAllRawSwaps(envioPool: Pool): Promise<EnvioRawSwapDbRow[]> {
  const result = await envioPool.query(`SELECT * FROM ${RAW_SWAP_TABLE}`);
  return result.rows as EnvioRawSwapDbRow[];
}
```

- [ ] **Step 7: Write `be/src/envioSync/runSync.ts`**

```typescript
import type { Pool } from 'pg';
import type { Address } from 'viem';
import { hydrateV1Launch } from '../launchpads/pons/v1/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { envioRawLaunchToEvent, hydrateV1SwapFromDecoded, type EnvioRawLaunchRow, type EnvioRawSwapRow } from './transformV1Legacy.js';
import { readAllRawLaunches, readAllRawSwaps } from './envioDb.js';

const legacy = getPonsFactorySources()[0];

export async function syncV1LegacyOnce(envioPool: Pool, appDb: Database): Promise<{ launchesWritten: number; tradesWritten: number }> {
  const rawLaunches = await readAllRawLaunches(envioPool);
  const existingLaunches = new Set(
    (await appDb.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging))
      .map((row) => row.tokenAddress),
  );
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
    // Metadata/graduation state come from live RPC in the RPC-scanning path (be/src/indexer/factoryRuntime.ts);
    // this phase's staging tables intentionally omit that enrichment — see spec section 8 (scope for
    // Phase 1 is the launch/swap decode path only, not the full metadata/graduation pipeline).
    const { launch, venue } = hydrateV1Launch(event, legacy, {
      name: '', symbol: '', decimals: 18, liquidityPool: event.poolAddress,
    }, false);
    launchByPool.set(event.poolAddress, { launch, venue });
    if (existingLaunches.has(launch.tokenAddress)) continue;
    await appDb.insert(launchesEnvioStaging).values({
      chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name, symbol: launch.symbol,
      tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
      factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
      launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
      quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus,
    }).onConflictDoNothing();
    await appDb.insert(venuesEnvioStaging).values({
      id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
      effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
    }).onConflictDoNothing();
    launchesWritten += 1;
  }

  const rawSwaps = await readAllRawSwaps(envioPool);
  const existingTrades = new Set(
    (await appDb.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex }).from(tradesEnvioStaging))
      .map((row) => `${row.txHash}:${row.logIndex}`),
  );
  let tradesWritten = 0;
  for (const raw of rawSwaps) {
    const context = launchByPool.get(raw.poolAddress.toLowerCase());
    if (!context) continue;
    const key = `${raw.txHash.toLowerCase()}:${raw.logIndex}`;
    if (existingTrades.has(key)) continue;
    const row: EnvioRawSwapRow = {
      poolAddress: raw.poolAddress, sender: raw.sender, recipient: raw.recipient,
      amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1), sqrtPriceX96: BigInt(raw.sqrtPriceX96),
      liquidity: BigInt(raw.liquidity), tick: raw.tick, blockNumber: BigInt(raw.blockNumber),
      blockHash: raw.blockHash, txHash: raw.txHash, logIndex: raw.logIndex, timestamp: raw.timestamp,
    };
    const trade = hydrateV1SwapFromDecoded(row, context.venue, context.launch, raw.sender as Address);
    if (!trade) continue;
    await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
    }).onConflictDoNothing();
    tradesWritten += 1;
  }
  return { launchesWritten, tradesWritten };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm run test:integration -- src/envioSync/runSync.integration.test.ts`
Expected: PASS 1/1.

- [ ] **Step 9: Document the new env vars**

Append to `be/.env.example`:

```
# Envio sync layer (Phase 1 — Pons V1-legacy only). Points at the self-hosted Envio Postgres from
# envio/docker-compose.yaml; table/schema names confirmed empirically in Task 1 Step 7.
# ENVIO_DATABASE_URL=
# ENVIO_RAW_LAUNCH_TABLE=envio."RawLaunch"
# ENVIO_RAW_SWAP_TABLE=envio."RawSwap"
```

- [ ] **Step 10: Commit**

```bash
cd be && git add src/db/schema.ts drizzle/ src/envioSync/ .env.example
git commit -m "feat: sync Envio raw Pons V1-legacy data into staging tables, idempotently

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Comparison CLI

**Files:**
- Create: `be/src/envioSync/compareStaging.ts`
- Create: `be/src/envioSync/compareStaging.test.ts`
- Create: `be/src/cli/compareEnvioStaging.ts`
- Modify: `be/package.json` (new script)
- Modify: root `README.md`

**Interfaces:**
- Consumes: nothing new from earlier tasks besides the real/staging table row shapes already defined in `be/src/db/schema.ts`.
- Produces: `compareLaunchCounts(real: readonly { tokenAddress: string }[], staging: readonly { tokenAddress: string }[]): { onlyInReal: string[]; onlyInStaging: string[]; matching: number }` and the equivalent `compareTradeCounts` for `(txHash, logIndex)` keys — this task's own CLI is the only consumer inside this plan; the real live comparison described in spec section 6 is a later, separate plan.

- [ ] **Step 1: Write the failing test for `compareLaunchCounts`**

```typescript
import { describe, expect, it } from 'vitest';
import { compareLaunchCounts, compareTradeCounts } from './compareStaging.js';

describe('compareLaunchCounts', () => {
  it('reports tokens present in only one side and the matching count', () => {
    const real = [{ tokenAddress: '0xaaa' }, { tokenAddress: '0xbbb' }];
    const staging = [{ tokenAddress: '0xbbb' }, { tokenAddress: '0xccc' }];
    expect(compareLaunchCounts(real, staging)).toEqual({
      onlyInReal: ['0xaaa'], onlyInStaging: ['0xccc'], matching: 1,
    });
  });

  it('reports no diff when both sides match exactly', () => {
    const both = [{ tokenAddress: '0xaaa' }];
    expect(compareLaunchCounts(both, both)).toEqual({ onlyInReal: [], onlyInStaging: [], matching: 1 });
  });
});

describe('compareTradeCounts', () => {
  it('keys trades by (txHash, logIndex), not by row identity', () => {
    const real = [{ txHash: '0x1', logIndex: 0 }, { txHash: '0x1', logIndex: 1 }];
    const staging = [{ txHash: '0x1', logIndex: 0 }];
    expect(compareTradeCounts(real, staging)).toEqual({
      onlyInReal: ['0x1:1'], onlyInStaging: [], matching: 1,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/envioSync/compareStaging.test.ts`
Expected: FAIL — `Cannot find module './compareStaging.js'`.

- [ ] **Step 3: Write `compareStaging.ts`**

```typescript
export interface CountDiff {
  onlyInReal: string[];
  onlyInStaging: string[];
  matching: number;
}

export function compareLaunchCounts(
  real: readonly { tokenAddress: string }[],
  staging: readonly { tokenAddress: string }[],
): CountDiff {
  const realSet = new Set(real.map((row) => row.tokenAddress));
  const stagingSet = new Set(staging.map((row) => row.tokenAddress));
  return {
    onlyInReal: [...realSet].filter((address) => !stagingSet.has(address)).sort(),
    onlyInStaging: [...stagingSet].filter((address) => !realSet.has(address)).sort(),
    matching: [...realSet].filter((address) => stagingSet.has(address)).length,
  };
}

export function compareTradeCounts(
  real: readonly { txHash: string; logIndex: number }[],
  staging: readonly { txHash: string; logIndex: number }[],
): CountDiff {
  const key = (row: { txHash: string; logIndex: number }) => `${row.txHash}:${row.logIndex}`;
  const realSet = new Set(real.map(key));
  const stagingSet = new Set(staging.map(key));
  return {
    onlyInReal: [...realSet].filter((k) => !stagingSet.has(k)).sort(),
    onlyInStaging: [...stagingSet].filter((k) => !realSet.has(k)).sort(),
    matching: [...realSet].filter((k) => stagingSet.has(k)).length,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/envioSync/compareStaging.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Write the CLI wrapper**

```typescript
import { createDatabase } from '../db/client.js';
import { launches, trades } from '../db/schema.js';
import { launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { compareLaunchCounts, compareTradeCounts } from '../envioSync/compareStaging.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(databaseUrl);

try {
  const realLaunches = await db.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, 'pons-v1-legacy'));
  const stagingLaunches = await db.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging);
  const launchDiff = compareLaunchCounts(realLaunches, stagingLaunches);
  console.log('Launches — matching:', launchDiff.matching, 'only in real:', launchDiff.onlyInReal.length, 'only in staging:', launchDiff.onlyInStaging.length);
  if (launchDiff.onlyInReal.length) console.log('  only in real:', launchDiff.onlyInReal.slice(0, 20));
  if (launchDiff.onlyInStaging.length) console.log('  only in staging:', launchDiff.onlyInStaging.slice(0, 20));

  const realTrades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex }).from(trades).where(eq(trades.chainId, 4663));
  const stagingTrades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex }).from(tradesEnvioStaging);
  const tradeDiff = compareTradeCounts(realTrades, stagingTrades);
  console.log('Trades — matching:', tradeDiff.matching, 'only in real:', tradeDiff.onlyInReal.length, 'only in staging:', tradeDiff.onlyInStaging.length);
} finally {
  await pool.end();
}
```

- [ ] **Step 6: Add the npm script**

In `be/package.json`'s `scripts`, add:

```json
"compare:envio-staging": "tsx src/cli/compareEnvioStaging.ts"
```

- [ ] **Step 7: Document the manual end-to-end verification in README.md**

Append a short new Vietnamese section after the existing "Bộ lập lịch song song (job-queue) và rollback" section:

```markdown
### Envio HyperIndex — thử nghiệm Phase 1 (Pons V1-legacy)

Xem `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md` và
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase1.md`. Để thử nghiệm thủ công
sau khi cả 6 task của plan hoàn tất:

```sh
cd envio && docker compose up -d
# đợi indexer bắt kịp head hoặc ít nhất qua khỏi các block đã dùng làm fixture
cd .. && DATABASE_URL=... ENVIO_DATABASE_URL=... npm run -w be compare:envio-staging
```

Đây là bước đối chiếu thủ công cho phạm vi Phase 1 (chỉ V1-legacy). Đối chiếu tự động, đầy đủ,
chạy song song với indexer thật đang sống — theo mục 6 của spec — thuộc một plan kế tiếp riêng.
```

- [ ] **Step 8: Run the full `be` test suite**

Run: `cd be && npm test`
Expected: all tests pass, including every test added in Tasks 4–6.

- [ ] **Step 9: Commit**

```bash
cd be && git add src/envioSync/compareStaging.ts src/envioSync/compareStaging.test.ts src/cli/compareEnvioStaging.ts package.json
cd .. && git add README.md
git commit -m "feat: add Envio-vs-real staging comparison CLI for the Phase 1 slice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After this plan

This plan stops at a working, tested, isolated Phase-1 slice (V1-legacy launches + their official V3 pool swaps, flowing Envio → sync layer → staging tables, verified against the existing fixture) with zero changes to the real tables, the API, or the frontend. Per spec section 8, the next plans in order are: V2 factory + curve + lifecycle transitions (step 2); V4 pool verification (`PoolGraduated`+`Initialize` same-tx matching) + V4 swaps (step 3); the real parallel-run comparison against the live custom indexer and reorg-handling verification (steps 5–6, spec section 5–6); then cutover (step 7) and retirement of the custom indexer (step 8). Each gets its own plan once this one is reviewed and merged, per the spec's own phased rollout.
