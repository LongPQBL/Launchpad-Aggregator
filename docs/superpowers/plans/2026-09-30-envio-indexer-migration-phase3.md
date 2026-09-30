# Envio HyperIndex Migration — Phase 3 (Pons V2 → V4 pool verification + swaps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the same self-hosted Envio project and sync layer from Phases 1-2 to verify a graduated Pons V2 launch's official Uniswap V4 pool (matching `PoolGraduated` with `PoolManager.Initialize` in the same transaction, exactly like the existing RPC-scan pipeline does) and index that pool's official `Swap` events — verified against the project's existing fully-audited `pons-v2-graduated.json` fixture, which already has real `initialize`/`swap` data for this exact purpose.

**Architecture:** Genuinely different from Phases 1-2's per-launch dynamic-registration pattern. Uniswap V4 uses one singleton `PoolManager` contract (address `0x8366a39cc670b4001a1121b8f6a443a643e40951`, audited and hardcoded in `be/src/indexer/lifecycleRuntime.ts` as `expectedPoolManager`) shared by every pool on the chain — not a new contract per launch. Envio statically configures this one known address (simpler than Phase 1/2: no `contractRegister` needed at all) and captures its `Initialize`/`Swap` events with minimal transformation, chain-wide (not just Pons pools — see Global Constraints). The sync layer does all the real work: for each graduated lifecycle transition (from Phase 2's `lifecycle_transitions_envio_staging`) that doesn't yet have an opened `v4_pool` venue, it looks for a matching `Initialize` event in the *same transaction*, verifies it against the launch's real currencies and the hardcoded Pons hook address, and — critically, since this phase has no RPC access to the launch's pre-known `v4PoolFee`/`v4TickSpacing` — re-derives the expected pool ID directly from the `Initialize` event's own `fee`/`tickSpacing` fields and confirms it equals that event's own claimed `id` (a self-consistency check that is cryptographically no weaker than checking against separately-RPC-sourced terms, since the pool ID is a hash that already binds fee+tickSpacing+hooks+currencies together — verified empirically during planning: `derivePonsV4PoolId` reproduces the fixture's real pool ID exactly from the `Initialize` event's own fields). Once verified, the sync layer opens the `v4_pool` venue by reusing the existing RPC-scan pipeline's own `transitionOfficialVenue` function unchanged, then syncs that pool's `Swap` events into `trades_envio_staging`.

**Tech Stack:** Same as Phases 1-2 — Envio HyperIndex (self-hosted), Node.js >=24, TypeScript, Drizzle, `pg`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md` (already covers V4's business rules — official pool only after matching `PoolGraduated` with `PoolManager.Initialize` in the same tx; this plan implements exactly that verification for the Envio path, matching the RPC-scan path's existing behavior).

## Global Constraints

- Same as Phases 1-2's Global Constraints (`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase1.md`, `-phase2.md`): self-hosted only, real tables/API/frontend untouched, lowercase addresses, exact `(blockNumber, logIndex)` ordering, `null` never a faked value, Vietnamese docs / English code, Node >=24, never commit secrets.
- **`PoolManager` is shared chain-wide by every protocol using Uniswap V4 on Robinhood Chain, not just Pons.** Envio's raw `Initialize`/`Swap` capture is therefore chain-wide and unfiltered at that layer — Envio has no built-in mechanism found during this plan's research for filtering `Swap` by a dynamically-growing non-address value set (pool IDs are `bytes32`, not `address`; the `contractRegister`/`chain.<Contract>.addresses` dynamic-allowlist pattern Phases 1-2 used is address-only). All actual Pons-official-venue filtering happens in the sync layer, exactly matching the spec's "Envio owns minimal raw entities; sync layer applies all business logic" design. **This means the raw `RawV4Swap` table will contain non-Pons swap volume too** — a real scale/cost tradeoff to measure empirically during live verification (Task 2), not something to silently assume is fine. If chain-wide V4 swap volume proves too large during Task 2's live run, that is a Ruling point requiring a decision (documented if it comes up), not a silent scope change.
- **`PoolManager` and the Pons hook address are hardcoded, audited constants** (`0x8366a39cc670b4001a1121b8f6a443a643e40951` / `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`), matching `be/src/indexer/lifecycleRuntime.ts`'s `expectedPoolManager`/`expectedHook` exactly — reuse those exact values, do not re-derive or re-guess them.
- **V4 pool fee is always 0 for Pons pools** — `derivePonsV4PoolId` itself asserts this (`terms.fee !== 0` throws). Reuse that assertion as-is; do not weaken it.
- **Trader address comes from `tx.from`, not the Swap event's own `sender` param** — same established rule from Phases 1-2 (a real bug fixed twice already this migration: `RawSwap.txFrom`, `RawCurveTrade.txFrom`/`RawCurveBuyback.txFrom`). V4's `Swap` event's `sender` param serves a *different* purpose here — it identifies whether the hook contract itself initiated the swap (protocol activity), not the trader.

## Review Focus

- **A non-Pons V4 pool's `Initialize` event must never be accepted as an official venue.** Since `PoolManager` is shared chain-wide, an `Initialize` event for some unrelated protocol's pool could coincidentally land in the same block as (but a different transaction from) a Pons `PoolGraduated` — the same-transaction check (not just same-block) is what prevents this. Task 3's test includes a same-block-different-tx case that must be rejected.
- **The pool-ID self-consistency check must reject a currency mismatch, not just trust the `Initialize` event's claimed `id`.** An `Initialize` event whose `currency0`/`currency1` don't match the launch's actual token/quote addresses must be rejected even if its own `id` is internally consistent with its own `fee`/`tickSpacing`/`hooks` — otherwise a malicious or unrelated pool with the right hook but wrong currencies could slip through. Task 3's test covers a currency mismatch.
- **The hook address must be checked, not just trusted.** A pool using a *different* hook (not the audited Pons hook `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`) must be rejected, even with matching currencies — the hook is what makes a pool "Pons-operated" in the first place.
- **V4 swap side/amount mapping depends on currency0-vs-currency1 ordering, which is derived from address comparison, not assumed.** Like Phase 2's buy/sell leg-mapping risk, a copy-paste error swapping which signed amount is the token leg vs. the quote leg would silently invert every trade's side and amounts. Task 4's cross-check test uses the real fixture swap (a sell, per the decoded data: `amount0` negative/token leg, `amount1` positive/quote leg) to pin this.
- **Protocol-initiated swaps (hook-as-sender) must be classified correctly, not folded into `user_trade`.** `decodePonsV4Swap`'s existing behavior splits hook-initiated swaps into `protocol_buyback` or `protocol_fee_conversion` depending on side — Task 4's test must cover at least one hook-initiated case, not just the fixture's one real user swap.

---

## Task 1: PoolManager `Initialize` — raw capture

**Files:**
- Modify: `envio/config.yaml`
- Modify: `envio/schema.graphql`
- Modify: `envio/src/EventHandlers.ts`

**Interfaces:**
- Consumes: nothing new from Phases 1-2 (adds a sibling static contract; does not touch existing ones).
- Produces: `envio."RawV4Initialize"` (columns: `id`, `chainId`, `poolId`, `currency0`, `currency1`, `fee`, `tickSpacing`, `hooks`, `sqrtPriceX96`, `tick`, `blockNumber`, `blockHash`, `txHash`, `logIndex`) — Task 3's transform function consumes exactly this shape.

- [ ] **Step 1: Add the `PoolManager` contract and `Initialize` event to `config.yaml`**

Add to the existing `contracts:` list and `chains[0].contracts:` list (full file, extending Phase 2's version):

```yaml
# yaml-language-server: $schema=./node_modules/envio/evm.schema.json
name: pons-envio-indexer
field_selection:
  transaction_fields:
    - hash
    - from
contracts:
  - name: PonsV1LegacyFactory
    handler: src/EventHandlers.ts
    events:
      - event: "TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)"
  - name: PonsV3Pool
    handler: src/EventHandlers.ts
    events:
      - event: "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
  - name: PonsV2Factory
    handler: src/EventHandlers.ts
    events:
      - event: "TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
        name: TokenLaunchedV2
      - event: "LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)"
      - event: "PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)"
      - event: "LaunchGraduationRescued(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount)"
  - name: PonsV2Curve
    handler: src/EventHandlers.ts
    events:
      - event: "CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)"
      - event: "CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)"
      - event: "BuybackLocked(uint256 quoteSpent, uint256 tokensLocked)"
  - name: UniswapV4PoolManager
    handler: src/EventHandlers.ts
    events:
      - event: "Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
      - event: "Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
        name: V4Swap
chains:
  - id: 4663
    hypersync_config:
      url: https://robinhood.hypersync.xyz
    start_block: 8600612
    contracts:
      - name: PonsV1LegacyFactory
        address:
          - "0x0c37a24F5D23A486FA692d1500881d698B1F77a4"
      - name: PonsV3Pool
      - name: PonsV2Factory
        address:
          - "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"
      - name: PonsV2Curve
      - name: UniswapV4PoolManager
        address:
          - "0x8366a39cC670b4001a1121b8f6A443A643E40951"
```

`UniswapV4PoolManager` has a **static** `address:` under `chains[0].contracts` — unlike Phase 1/2's dynamically-registered contracts, this is one known, fixed address (`be/src/indexer/lifecycleRuntime.ts`'s `expectedPoolManager`), so no `contractRegister` is needed at all. `name: V4Swap` on the `Swap` event disambiguates it from `PonsV3Pool`'s own `Swap` event, same reason Phase 2 used `name: TokenLaunchedV2`.

- [ ] **Step 2: Add the `RawV4Initialize` entity to `schema.graphql`**

Append to the existing file:

```graphql
type RawV4Initialize {
  id: ID!
  chainId: Int!
  poolId: String!
  currency0: String!
  currency1: String!
  fee: Int!
  tickSpacing: Int!
  hooks: String!
  sqrtPriceX96: BigInt!
  tick: Int!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
}
```

- [ ] **Step 3: Add the `Initialize` handler**

Append to `envio/src/EventHandlers.ts`:

```typescript
indexer.onEvent(
  { contract: "UniswapV4PoolManager", event: "Initialize" },
  async ({ event, context }) => {
    context.RawV4Initialize.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolId: event.params.id.toLowerCase(),
      currency0: event.params.currency0.toLowerCase(),
      currency1: event.params.currency1.toLowerCase(),
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      hooks: event.params.hooks.toLowerCase(),
      sqrtPriceX96: event.params.sqrtPriceX96,
      tick: Number(event.params.tick),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);
```

`event.params.fee`/`tickSpacing`/`tick` (the raw ABI `uint24`/`int24` types) already have `Number(...)` applied above — confirmed necessary via real `tsc` output while executing this task (same finding as Phase 2's Task 3 for V1's `tick`).

- [ ] **Step 4: Codegen and typecheck**

```bash
cd envio && pnpm codegen && npx tsc --noEmit
```

Expected: both succeed after any real `Number(...)` fixes the compiler demands (see Step 3's note).

- [ ] **Step 5: Clean-volume restart and run past the fixture's initialize block**

```bash
docker compose down -v && docker compose up -d --build
```

This is the first task to index chain-wide from a static `PoolManager` address rather than a Pons-specific factory — expect real HyperSync rate-limiting on the free tier during a full-range run (Phases 1-2 both hit this; see their ledgers). If verification against the full `start_block: 8600612` range doesn't complete in a reasonable time, apply the same temporary-narrowing-for-verification-only technique Phase 2 used (narrow `start_block`/add `end_block` locally, verify, then restore the full production config before committing — never commit a narrowed config). Poll by querying `envio."RawV4Initialize"` for the fixture's row (Step 6) rather than watching logs. Then:

```bash
docker compose stop envio-indexer
```

- [ ] **Step 6: Verify the fixture's Initialize event landed correctly**

```bash
docker exec envio-envio-postgres-1 psql -U postgres -d envio-dev -c \
  'SELECT "poolId", currency0, currency1, fee, "tickSpacing", hooks, "sqrtPriceX96", tick, "blockNumber", "logIndex" FROM envio."RawV4Initialize" WHERE "txHash" = '"'"'0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3'"'"';'
```

Expected: exactly one row — `poolId = '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1'`, `currency0 = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29'`, `currency1 = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'`, `fee = 0`, `tickSpacing = 200`, `hooks = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'`, `sqrtPriceX96 = 35770440558388723973569516`, `tick = -154068`, `blockNumber = 27828161`, `logIndex = 16` — matching `be/tests/fixtures/pons-v2-graduated.json`'s `initialize` block exactly (independently decoded via `decodeEventLog` during this plan's preparation).

- [ ] **Step 7: Commit**

```bash
git add envio/config.yaml envio/schema.graphql envio/src/
git commit -m "feat: index Uniswap V4 PoolManager Initialize via Envio, verified against the graduated fixture

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: PoolManager `Swap` (V4) — raw capture

**Files:**
- Modify: `envio/schema.graphql`
- Modify: `envio/src/EventHandlers.ts`

**Interfaces:**
- Consumes: `UniswapV4PoolManager`'s static registration from Task 1 (the `V4Swap`-named event is already declared in Task 1 Step 1's `config.yaml` — this task only adds the handler and entity).
- Produces: `envio."RawV4Swap"` (columns: `id`, `chainId`, `poolId`, `sender`, `txFrom`, `amount0`, `amount1`, `sqrtPriceX96`, `liquidity`, `tick`, `fee`, `blockNumber`, `blockHash`, `txHash`, `logIndex`, `timestamp`) — Task 4's transform function consumes exactly this shape.

- [ ] **Step 1: Add the `RawV4Swap` entity to `schema.graphql`**

Append:

```graphql
type RawV4Swap {
  id: ID!
  chainId: Int!
  poolId: String!
  # `sender` distinguishes a hook-initiated swap (protocol activity) from a user swap — NOT the
  # trader. See envio/schema.graphql's RawSwap.txFrom comment for why: same distinction as V1/V2.
  sender: String!
  txFrom: String!
  amount0: BigInt!
  amount1: BigInt!
  sqrtPriceX96: BigInt!
  liquidity: BigInt!
  tick: Int!
  fee: Int!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
  timestamp: Int!
}
```

- [ ] **Step 2: Add the `Swap` (V4) handler**

Append to `envio/src/EventHandlers.ts`:

```typescript
indexer.onEvent(
  { contract: "UniswapV4PoolManager", event: "V4Swap" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for V4 swap ${event.transaction.hash}`);
    context.RawV4Swap.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolId: event.params.id.toLowerCase(),
      sender: event.params.sender.toLowerCase(),
      txFrom: event.transaction.from.toLowerCase(),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee: Number(event.params.fee),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);
```

- [ ] **Step 3: Codegen, typecheck, clean-volume restart, run past the fixture swap block**

```bash
cd envio && pnpm codegen && npx tsc --noEmit
docker compose down -v && docker compose up -d --build
```

Same rate-limiting/narrowing note as Task 1 Step 5 applies. Wait until indexing has passed block `27828165`, then:

```bash
docker compose stop envio-indexer
```

- [ ] **Step 4: Verify the fixture V4 swap landed correctly, and measure chain-wide swap volume**

```bash
docker exec envio-envio-postgres-1 psql -U postgres -d envio-dev -c \
  'SELECT "poolId", sender, amount0, amount1, "sqrtPriceX96", liquidity, tick, "blockNumber", "logIndex" FROM envio."RawV4Swap" WHERE "txHash" = '"'"'0x9f9e677944d822a0f5f46307b098b0b1c593751492b25a7f5c6a02483ad40977'"'"';'
docker exec envio-envio-postgres-1 psql -U postgres -d envio-dev -c 'SELECT count(*) FROM envio."RawV4Swap";'
```

Expected first query: exactly one row — `poolId = '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1'`, `sender = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc'`, `amount0 = -31880381102749799957318148`, `amount1 = 5620497268881825819`, `sqrtPriceX96 = 30937564032784793309170036`, `liquidity = 92140088551983424601325`, `tick = -156971`, `blockNumber = 27828165`, `logIndex = 108` — matching the fixture's `swap` block exactly. Record the second query's real count in this task's ledger entry — this is the Global Constraints' "measure chain-wide volume" checkpoint; if it is unexpectedly large for the scanned range, note it as a finding (not a blocker — Task 5's sync layer only processes swaps whose `poolId` matches a *verified* Pons pool, so a large raw table is a storage/indexing-time cost, not a correctness problem, but worth recording for the later parallel-run plan's own capacity planning).

- [ ] **Step 5: Commit**

```bash
git add envio/schema.graphql envio/src/
git commit -m "feat: index Uniswap V4 PoolManager Swap events via Envio, verified against the graduated fixture

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Sync-layer V4 pool verification and venue opening

**Files:**
- Create: `be/src/envioSync/transformV4.ts`
- Create: `be/src/envioSync/transformV4.test.ts`

**Interfaces:**
- Consumes: `derivePonsV4PoolId`, `transitionOfficialVenue`, `V4PoolTerms`, `GraduatedPoolEvidence` from `be/src/launchpads/pons/v2/poolKey.js`; `Launch`, `Venue` from `be/src/domain/types.js`; `venueKey` from `be/src/domain/ids.js`.
- Produces: `verifyV4PoolFromEnvio(initializeRow: EnvioRawV4InitializeRow, graduatedTxHash: string, graduatedBlockHash: string, launch: Launch): GraduatedPoolEvidence | null` and `openV4Venue(launch: Launch, curveVenue: Venue, evidence: GraduatedPoolEvidence, position: { blockNumber: bigint; logIndex: number }): Venue` — Task 5's sync script consumes both.

- [ ] **Step 1: Write the failing test for accepting the real fixture pool**

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { Launch, Venue } from '../domain/types.js';
import { venueKey } from '../domain/ids.js';
import { verifyV4PoolFromEnvio, openV4Venue, type EnvioRawV4InitializeRow } from './transformV4.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const launch: Launch = {
  chainId: 4663, tokenAddress: fixture.tokenAddress as Address, name: null as unknown as string, symbol: null as unknown as string,
  tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: 'l2',
  factoryAddress: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address, deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2' as Address,
  launchBlock: 27823666n, launchTxHash: (fixture.launch as Record<string, unknown>).transactionHash as `0x${string}`,
  quoteAsset: { address: fixture.quoteAddress as Address, symbol: 'NVDA', decimals: 18 }, lifecycleStatus: 'graduated',
};
const curveVenue: Venue = {
  id: venueKey(4663, 'curve', fixture.curveAddress as string), chainId: 4663, tokenAddress: launch.tokenAddress,
  kind: 'curve', ref: fixture.curveAddress as string, sourceId: 'pons-v2', sourceLogId: 'l2',
  effectiveFromBlock: 27823666n, effectiveToBlock: 27823772n, official: true,
};
const graduatedTxHash = '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3';
const graduatedBlockHash = '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e';

function initializeRow(overrides: Partial<EnvioRawV4InitializeRow> = {}): EnvioRawV4InitializeRow {
  return {
    poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
    currency0: fixture.tokenAddress as string,
    currency1: fixture.quoteAddress as string,
    fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    txHash: graduatedTxHash, blockHash: graduatedBlockHash,
    blockNumber: 27828161n, logIndex: 16,
    ...overrides,
  };
}

describe('verifyV4PoolFromEnvio', () => {
  it('accepts the real fixture Initialize event matched to the real graduation tx', () => {
    const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch);
    expect(evidence).not.toBeNull();
    expect(evidence!.poolId).toBe('0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
  });

  it('rejects an Initialize event from a different transaction (same block is not enough)', () => {
    const row = initializeRow({ txHash: '0x' + '7'.repeat(64) });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });

  it('rejects an Initialize event whose currencies do not match the launch', () => {
    const row = initializeRow({ currency1: '0x1111111111111111111111111111111111111111' });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });

  it('rejects an Initialize event using a hook other than the audited Pons hook', () => {
    const row = initializeRow({ hooks: '0x2222222222222222222222222222222222222222' });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });
});

describe('openV4Venue', () => {
  it('opens an official v4_pool venue at the graduation position', () => {
    const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch)!;
    const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: 27828161n, logIndex: 36 });
    expect(venue.kind).toBe('v4_pool');
    expect(venue.ref).toBe('0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
    expect(venue.official).toBe(true);
    expect(venue.effectiveFromBlock).toBe(27828161n);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformV4.test.ts`
Expected: FAIL — `Cannot find module './transformV4.js'`.

- [ ] **Step 3: Write `verifyV4PoolFromEnvio` and `openV4Venue`**

```typescript
import type { Address, Hash } from 'viem';
import { venueKey } from '../domain/ids.js';
import { derivePonsV4PoolId, transitionOfficialVenue, type GraduatedPoolEvidence, type V4PoolTerms } from '../launchpads/pons/v2/poolKey.js';
import type { Launch, Venue } from '../domain/types.js';

const PONS_HOOK: Address = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';

export interface EnvioRawV4InitializeRow {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

// Unlike the RPC-scan path (which independently knows the launch's v4PoolFee/v4TickSpacing from a
// factory-state RPC read made at launch time, and checks the Initialize event against those
// pre-known values), this phase's sync layer has no RPC access — so it reads fee/tickSpacing directly
// from the candidate Initialize event itself, then re-derives the expected pool ID from those values
// plus the launch's real currencies plus the hardcoded Pons hook, and confirms it equals the event's
// own claimed id. This is not weaker: derivePonsV4PoolId's hash already binds fee+tickSpacing+hooks+
// currencies together, so a mismatched currency or hook still fails even though fee/tickSpacing come
// from the event under test — confirmed empirically during planning (derivePonsV4PoolId reproduces
// the fixture's real, on-chain pool ID exactly from these exact fields).
export function verifyV4PoolFromEnvio(
  row: EnvioRawV4InitializeRow,
  graduatedTxHash: string,
  graduatedBlockHash: string,
  launch: Launch,
): GraduatedPoolEvidence | null {
  if (row.txHash.toLowerCase() !== graduatedTxHash.toLowerCase() || row.blockHash.toLowerCase() !== graduatedBlockHash.toLowerCase()) {
    return null;
  }
  if (row.hooks.toLowerCase() !== PONS_HOOK.toLowerCase()) return null;
  const terms: V4PoolTerms = { fee: row.fee, tickSpacing: row.tickSpacing };
  let expectedId: Hash;
  try {
    expectedId = derivePonsV4PoolId(launch, terms, PONS_HOOK);
  } catch {
    return null;
  }
  if (expectedId.toLowerCase() !== row.poolId.toLowerCase()) return null;
  const [expectedCurrency0, expectedCurrency1] = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase()
    ? [launch.tokenAddress, launch.quoteAsset.address] : [launch.quoteAsset.address, launch.tokenAddress];
  if (row.currency0.toLowerCase() !== expectedCurrency0.toLowerCase() || row.currency1.toLowerCase() !== expectedCurrency1.toLowerCase()) {
    return null;
  }
  return { poolId: row.poolId.toLowerCase() as Hash, sourceLogId: `v4-init-${row.txHash.toLowerCase()}-${row.logIndex}`, sourceId: 'pons-v2-v4' };
}

export function openV4Venue(launch: Launch, curveVenue: Venue, evidence: GraduatedPoolEvidence, position: { blockNumber: bigint; logIndex: number }): Venue {
  const transition = transitionOfficialVenue(launch, curveVenue, 2, position, evidence);
  if (!transition.openedPool) throw new Error('Expected an opened V4 pool venue');
  return transition.openedPool;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformV4.test.ts`
Expected: PASS 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/envioSync/transformV4.ts src/envioSync/transformV4.test.ts
git commit -m "feat: verify Pons V4 pools from Envio raw data and open official venues

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Sync-layer V4 swap transform

**Files:**
- Modify: `be/src/envioSync/transformV4.ts`
- Modify: `be/src/envioSync/transformV4.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `Launch`, `Trade`, `Venue` from Task 3's own imports).
- Produces: `hydrateV4SwapFromDecoded(row: EnvioRawV4SwapRow, venue: Venue, launch: Launch): Trade | null` — Task 5's sync script consumes this.

- [ ] **Step 1: Write the failing cross-check test for the real fixture swap (a sell)**

Append to `transformV4.test.ts`:

```typescript
import { decodePonsV4Swap } from '../launchpads/pons/v2/v4Swaps.js';
import { hydrateV4SwapFromDecoded, type EnvioRawV4SwapRow } from './transformV4.js';

describe('hydrateV4SwapFromDecoded', () => {
  const v4Venue: Venue = {
    id: venueKey(4663, 'v4_pool', '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1'),
    chainId: 4663, tokenAddress: launch.tokenAddress, kind: 'v4_pool',
    ref: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
    sourceId: 'pons-v2-v4', sourceLogId: 'v4-init-x', effectiveFromBlock: 27828161n, official: true,
  };
  const poolManager = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
  const hook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address;

  it('produces the same Trade as decodePonsV4Swap for the real fixture swap (a sell)', () => {
    const swapLog = fixture.swap as Record<string, unknown>;
    const expected = decodePonsV4Swap(
      { address: swapLog.address as Address, topics: swapLog.topics as Hash[], data: swapLog.data as Hash,
        blockNumber: 27828165n, blockHash: swapLog.blockHash as Hash, transactionHash: swapLog.transactionHash as Hash, logIndex: 108 },
      '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1' as Hash,
      launch, v4Venue, 1_700_000_000, '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc' as Address, poolManager, hook,
    );
    const row: EnvioRawV4SwapRow = {
      poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      sender: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
      txFrom: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
      amount0: -31880381102749799957318148n,
      amount1: 5620497268881825819n,
      sqrtPriceX96: 30937564032784793309170036n,
      liquidity: 92140088551983424601325n,
      tick: -156971,
      blockNumber: 27828165n, blockHash: swapLog.blockHash as string, txHash: swapLog.transactionHash as string,
      logIndex: 108, timestamp: 1_700_000_000,
    };
    const trade = hydrateV4SwapFromDecoded(row, v4Venue, launch);
    expect(trade).toEqual(expected);
    expect(trade!.side).toBe('sell');
    expect(trade!.activityKind).toBe('user_trade');
  });

  it('classifies a hook-initiated swap as protocol activity, not user_trade', () => {
    const row: EnvioRawV4SwapRow = {
      poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      sender: hook, txFrom: hook,
      amount0: -1_000_000_000_000_000_000n, amount1: 500_000_000_000_000_000n,
      sqrtPriceX96: 30937564032784793309170036n, liquidity: 92140088551983424601325n, tick: -156971,
      blockNumber: 27829000n, blockHash: '0x' + 'f'.repeat(64), txHash: '0x' + '6'.repeat(64),
      logIndex: 2, timestamp: 1_700_000_500,
    };
    const trade = hydrateV4SwapFromDecoded(row, v4Venue, launch);
    expect(trade).not.toBeNull();
    expect(trade!.activityKind).not.toBe('user_trade');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformV4.test.ts`
Expected: FAIL — `hydrateV4SwapFromDecoded` is not exported.

- [ ] **Step 3: Write `hydrateV4SwapFromDecoded`**

Append to `transformV4.ts`:

```typescript
import type { Trade } from '../domain/types.js';

export interface EnvioRawV4SwapRow {
  poolId: string;
  sender: string;
  txFrom: string;
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

// Mirrors decodePonsV4Swap's output exactly (be/src/launchpads/pons/v2/v4Swaps.ts) but Envio already
// decoded the event, so there is no raw log to re-decode — same pattern as Phase 2's curve trade
// transform. `sender` classifies protocol-vs-user activity (hook-initiated); `txFrom` (tx.from, not
// `sender`) is the real trader.
export function hydrateV4SwapFromDecoded(row: EnvioRawV4SwapRow, venue: Venue, launch: Launch): Trade | null {
  if (venue.kind !== 'v4_pool' || !venue.official || row.poolId.toLowerCase() !== venue.ref.toLowerCase()) {
    throw new Error('Swap is not from the official V4 pool');
  }
  const protocolSwap = row.sender.toLowerCase() === PONS_HOOK.toLowerCase();
  const tokenIsCurrency0 = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase();
  const tokenSigned = tokenIsCurrency0 ? row.amount0 : row.amount1;
  const quoteSigned = tokenIsCurrency0 ? row.amount1 : row.amount0;
  if (tokenSigned === 0n || quoteSigned === 0n) return null;
  if (tokenSigned * quoteSigned >= 0n || row.sqrtPriceX96 === 0n) throw new Error('Invalid V4 swap amounts or price');
  const q192 = 2n ** 192n;
  const sqrtSquared = row.sqrtPriceX96 * row.sqrtPriceX96;
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id,
    blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash, logIndex: row.logIndex, timestamp: row.timestamp,
    side: quoteSigned < 0n ? 'buy' : 'sell',
    tokenAmountRaw: tokenSigned < 0n ? -tokenSigned : tokenSigned,
    quoteAmountRaw: quoteSigned < 0n ? -quoteSigned : quoteSigned,
    quoteAssetAddress: launch.quoteAsset.address, sourceEvent: 'Swap',
    activityKind: protocolSwap ? (quoteSigned < 0n ? 'protocol_buyback' : 'protocol_fee_conversion') : 'user_trade',
    priceNumeratorRaw: (tokenIsCurrency0 ? sqrtSquared : q192) * 10n ** BigInt(launch.tokenDecimals),
    priceDenominatorRaw: (tokenIsCurrency0 ? q192 : sqrtSquared) * 10n ** BigInt(launch.quoteAsset.decimals),
    traderAddress: row.txFrom.toLowerCase() as Address,
  };
}
```

Add `import type { Venue } from '../domain/types.js';` alongside the existing `Launch`/`Trade` import if not already present from Task 3 (check the file's current import line before appending a duplicate).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformV4.test.ts`
Expected: PASS 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/envioSync/transformV4.ts src/envioSync/transformV4.test.ts
git commit -m "feat: reimplement Pons V4 swap business logic for the Envio sync layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Staging integration — `syncV4Once`

**Files:**
- Create: `be/src/envioSync/runSyncV4.ts`
- Create: `be/src/envioSync/runSyncV4.integration.test.ts`
- Modify: `be/.env.example`

**Interfaces:**
- Consumes: `verifyV4PoolFromEnvio`, `openV4Venue`, `hydrateV4SwapFromDecoded` from Tasks 3-4.
- Produces: `syncV4Once(envioPool: Pool, appDb: Database, tables?: EnvioV4TableNames): Promise<{ venuesOpened: number; tradesWritten: number }>` — Task 6's CLI extensions call this alongside `syncV1LegacyOnce`/`syncV2Once`.

This task deliberately does **not** need a schema migration: it reuses `venuesEnvioStaging`/`tradesEnvioStaging` (already `kind`/kind-agnostic) and reads `lifecycleTransitionsEnvioStaging` (already written by Phase 2's `syncV2Once`) — no new staging table.

- [ ] **Step 1: Write the failing integration test**

Real finding during execution: the plan's first draft of this test reused the real
`pons-v2-graduated.json` fixture's exact token/curve addresses (matching Tasks 1-4's cross-check
values). That collides with `runSync.integration.test.ts`/`runSyncV2.integration.test.ts`, which use
the *same* real fixture token for their own seeded rows — Vitest runs integration test files in
parallel, so those files' `beforeAll`/`afterAll` DELETE+INSERT cycles for that one real token raced
against this file's own cycles for the exact same row (reproduced live: intermittent
`venuesOpened: 0` failures, 3 of 4 full-suite runs, traced to a concurrent file's cleanup deleting
this file's freshly-inserted `lifecycle_transitions_envio_staging`/`venues_envio_staging` rows out
from under it). The fix — already applied below — is to use fully synthetic, non-colliding
token/curve/quote addresses for this file's own seeded staging rows, and derive the expected pool ID
from them via `derivePonsV4PoolId` directly (rather than hardcoding the real fixture's pool ID, which
would no longer match self-consistently once the currencies change). The audited Pons hook address
stays real, since `verifyV4PoolFromEnvio` checks against that exact hardcoded constant.

```typescript
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Pool } from 'pg';
import type { Address } from 'viem';
import { createDatabase } from '../db/client.js';
import { venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { derivePonsV4PoolId } from '../launchpads/pons/v2/poolKey.js';
import type { Launch } from '../domain/types.js';
import { syncV4Once } from './runSyncV4.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = {
  rawV4InitializeTable: 'envio_fixture_v4."RawV4Initialize"',
  rawV4SwapTable: 'envio_fixture_v4."RawV4Swap"',
};
// Deliberately synthetic, distinct from the real pons-v2-graduated.json fixture's token/curve
// addresses that runSync.integration.test.ts and runSyncV2.integration.test.ts also use — see this
// step's note above for why.
const testToken = '0x4444444444444444444444444444444444444444' as Address;
const testQuote = '0x5555555555555555555555555555555555555555' as Address;
const testCurve = '0x6666666666666666666666666666666666666666';
const testHook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address; // the real, audited Pons hook — must stay real
const testSwapTxHash = '0x' + 'a'.repeat(64);
const testGraduationTxHash = '0x' + 'b'.repeat(64);
const testGraduationBlockHash = '0x' + 'c'.repeat(64);

const syntheticLaunch: Launch = {
  chainId: 4663, tokenAddress: testToken, name: '', symbol: '', tokenDecimals: 18,
  platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
  factoryAddress: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address, deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2' as Address,
  launchBlock: 27823666n, launchTxHash: ('0x' + 'd'.repeat(64)) as `0x${string}`,
  quoteAsset: { address: testQuote, symbol: '', decimals: 18 }, lifecycleStatus: 'graduated',
};
// Derived, not hardcoded — must be internally self-consistent for verifyV4PoolFromEnvio to accept it.
const testPoolId = derivePonsV4PoolId(syntheticLaunch, { fee: 0, tickSpacing: 200 }, testHook);

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_v4');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v4."RawV4Initialize" (
    id text primary key, "chainId" int, "poolId" text, currency0 text, currency1 text,
    fee int, "tickSpacing" int, hooks text, "sqrtPriceX96" numeric, tick int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v4."RawV4Swap" (
    id text primary key, "chainId" int, "poolId" text, sender text, "txFrom" text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, liquidity numeric, tick int, fee int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await pool.query('DELETE FROM lifecycle_transitions_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testSwapTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query(
    `INSERT INTO launches_envio_staging (chain_id, token_address, name, symbol, token_decimals, platform, protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status) VALUES (4663,$1,null,null,18,'pons','v2',$2,$3,27823666,$4,$5,null,null,'graduated')`,
    [testToken, syntheticLaunch.factoryAddress, syntheticLaunch.deployerAddress, syntheticLaunch.launchTxHash, testQuote],
  );
  await pool.query(
    `INSERT INTO venues_envio_staging (id, chain_id, token_address, kind, ref, effective_from_block, official) VALUES ($1,4663,$2,'curve',$3,27823666,true)`,
    [`4663:curve:${testCurve}`, testToken, testCurve],
  );
  await pool.query(
    `INSERT INTO lifecycle_transitions_envio_staging (source_log_id, chain_id, token_address, phase, kind, block_number, block_hash, tx_hash, log_index) VALUES ($1,4663,$2,2,'graduated',27828161,$3,$4,36)`,
    [`4663:${testGraduationBlockHash}:${testGraduationTxHash}:36`, testToken, testGraduationBlockHash, testGraduationTxHash],
  );
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture_v4 CASCADE');
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testSwapTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM lifecycle_transitions_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await pool.end();
  await envioPool.end();
});

describe('syncV4Once', () => {
  it('opens the verified V4 venue and syncs its swap, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture_v4."RawV4Initialize" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      ['i1', 4663, testPoolId, testToken, testQuote,
        0, 200, testHook, '35770440558388723973569516', -154068,
        '27828161', testGraduationBlockHash, testGraduationTxHash, 16],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture_v4."RawV4Swap" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      ['s1', 4663, testPoolId, '0x9999999999999999999999999999999999999999', '0x9999999999999999999999999999999999999999',
        '-1000000000000000000', '500000000000000000', '30937564032784793309170036',
        '92140088551983424601325', -156971, 0,
        '27828165', '0x' + 'e'.repeat(64), testSwapTxHash, 108, 1_700_000_000],
    );

    const first = await syncV4Once(envioPool, db, fixtureTables);
    expect(first).toEqual({ venuesOpened: 1, tradesWritten: 1 });
    const venues = await db.select().from(venuesEnvioStaging).where(and(eq(venuesEnvioStaging.tokenAddress, testToken), eq(venuesEnvioStaging.kind, 'v4_pool')));
    expect(venues).toHaveLength(1);
    expect(venues[0].ref).toBe(testPoolId);
    const trades = await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testSwapTxHash));
    expect(trades).toHaveLength(1);

    const second = await syncV4Once(envioPool, db, fixtureTables);
    expect(second).toEqual({ venuesOpened: 0, tradesWritten: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- src/envioSync/runSyncV4.integration.test.ts`
Expected: FAIL — `Cannot find module './runSyncV4.js'`.

- [ ] **Step 3: Write `runSyncV4.ts`**

```typescript
import type { Pool } from 'pg';
import { and, eq, notExists } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { verifyV4PoolFromEnvio, openV4Venue, hydrateV4SwapFromDecoded, type EnvioRawV4InitializeRow, type EnvioRawV4SwapRow } from './transformV4.js';

export interface EnvioV4TableNames {
  rawV4InitializeTable: string;
  rawV4SwapTable: string;
}

export const DEFAULT_ENVIO_V4_TABLES: EnvioV4TableNames = {
  rawV4InitializeTable: 'envio."RawV4Initialize"',
  rawV4SwapTable: 'envio."RawV4Swap"',
};

export async function syncV4Once(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV4TableNames = DEFAULT_ENVIO_V4_TABLES,
): Promise<{ venuesOpened: number; tradesWritten: number }> {
  // Graduated launches that don't yet have a v4_pool venue opened.
  const pendingGraduations = await appDb
    .select({
      tokenAddress: lifecycleTransitionsEnvioStaging.tokenAddress,
      txHash: lifecycleTransitionsEnvioStaging.txHash,
      blockHash: lifecycleTransitionsEnvioStaging.blockHash,
      blockNumber: lifecycleTransitionsEnvioStaging.blockNumber,
      logIndex: lifecycleTransitionsEnvioStaging.logIndex,
    })
    .from(lifecycleTransitionsEnvioStaging)
    .where(and(
      eq(lifecycleTransitionsEnvioStaging.kind, 'graduated'),
      notExists(appDb.select().from(venuesEnvioStaging).where(and(
        eq(venuesEnvioStaging.tokenAddress, lifecycleTransitionsEnvioStaging.tokenAddress),
        eq(venuesEnvioStaging.kind, 'v4_pool'),
      ))),
    ));

  const rawInitializes = (await envioPool.query(`SELECT * FROM ${tables.rawV4InitializeTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawV4InitializeRow[];
  let venuesOpened = 0;
  for (const graduation of pendingGraduations) {
    const launchRow = (await appDb.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, graduation.tokenAddress)))[0];
    const curveVenueRow = (await appDb.select().from(venuesEnvioStaging).where(and(
      eq(venuesEnvioStaging.tokenAddress, graduation.tokenAddress), eq(venuesEnvioStaging.kind, 'curve'),
    )))[0];
    if (!launchRow || !curveVenueRow) continue;
    const launch: Launch = {
      chainId: launchRow.chainId, tokenAddress: launchRow.tokenAddress as `0x${string}`,
      name: launchRow.name ?? '', symbol: launchRow.symbol ?? '', tokenDecimals: launchRow.tokenDecimals,
      platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
      factoryAddress: launchRow.factoryAddress as `0x${string}`, deployerAddress: launchRow.deployerAddress as `0x${string}`,
      launchBlock: launchRow.launchBlock, launchTxHash: launchRow.launchTxHash as `0x${string}`,
      quoteAsset: { address: launchRow.quoteAssetAddress as `0x${string}`, symbol: launchRow.quoteAssetSymbol ?? '', decimals: launchRow.quoteAssetDecimals ?? 18 },
      lifecycleStatus: 'graduated',
    };
    const curveVenue: Venue = {
      id: curveVenueRow.id, chainId: curveVenueRow.chainId, tokenAddress: curveVenueRow.tokenAddress as `0x${string}`,
      kind: 'curve', ref: curveVenueRow.ref, sourceId: 'pons-v2', sourceLogId: '',
      effectiveFromBlock: curveVenueRow.effectiveFromBlock, effectiveToBlock: null, official: curveVenueRow.official,
    };
    const candidate = rawInitializes.find((row) => row.txHash.toLowerCase() === graduation.txHash.toLowerCase());
    if (!candidate) continue;
    const row: EnvioRawV4InitializeRow = { ...candidate, blockNumber: BigInt(candidate.blockNumber) };
    const evidence = verifyV4PoolFromEnvio(row, graduation.txHash, graduation.blockHash, launch);
    if (!evidence) continue;
    const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: graduation.blockNumber, logIndex: graduation.logIndex });
    const venueRows = await appDb.insert(venuesEnvioStaging).values({
      id: venue.id, chainId: venue.chainId, tokenAddress: venue.tokenAddress, kind: venue.kind, ref: venue.ref,
      effectiveFromBlock: venue.effectiveFromBlock, official: venue.official,
    }).onConflictDoNothing().returning({ id: venuesEnvioStaging.id });
    if (venueRows.length > 0) venuesOpened += 1;
  }

  // Deliberately re-fetches launch/venue from staging here rather than reusing the objects built in
  // the venue-opening loop above — a v4_pool venue opened in an EARLIER run (not this pass) still
  // needs its swaps synced, so this loop must work uniformly for both "just opened" and
  // "already open" venues, not special-case the former via an in-memory map.
  let tradesWritten = 0;
  const rawSwaps = (await envioPool.query(`SELECT * FROM ${tables.rawV4SwapTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawV4SwapRow[];
  const v4Venues = await appDb.select().from(venuesEnvioStaging).where(eq(venuesEnvioStaging.kind, 'v4_pool'));
  const venueByPoolId = new Map(v4Venues.map((v) => [v.ref.toLowerCase(), v]));
  for (const raw of rawSwaps) {
    const venueRow = venueByPoolId.get(raw.poolId.toLowerCase());
    if (!venueRow) continue;
    const launchRow = (await appDb.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, venueRow.tokenAddress)))[0];
    if (!launchRow) continue;
    const launch: Launch = {
      chainId: launchRow.chainId, tokenAddress: launchRow.tokenAddress as `0x${string}`,
      name: launchRow.name ?? '', symbol: launchRow.symbol ?? '', tokenDecimals: launchRow.tokenDecimals,
      platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
      factoryAddress: launchRow.factoryAddress as `0x${string}`, deployerAddress: launchRow.deployerAddress as `0x${string}`,
      launchBlock: launchRow.launchBlock, launchTxHash: launchRow.launchTxHash as `0x${string}`,
      quoteAsset: { address: launchRow.quoteAssetAddress as `0x${string}`, symbol: launchRow.quoteAssetSymbol ?? '', decimals: launchRow.quoteAssetDecimals ?? 18 },
      lifecycleStatus: 'graduated',
    };
    const venue: Venue = {
      id: venueRow.id, chainId: venueRow.chainId, tokenAddress: venueRow.tokenAddress as `0x${string}`,
      kind: 'v4_pool', ref: venueRow.ref, sourceId: 'pons-v2-v4', sourceLogId: '',
      effectiveFromBlock: venueRow.effectiveFromBlock, effectiveToBlock: null, official: venueRow.official,
    };
    const row: EnvioRawV4SwapRow = { ...raw, amount0: BigInt(raw.amount0), amount1: BigInt(raw.amount1),
      sqrtPriceX96: BigInt(raw.sqrtPriceX96), liquidity: BigInt(raw.liquidity), blockNumber: BigInt(raw.blockNumber) };
    const trade = hydrateV4SwapFromDecoded(row, venue, launch);
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

  return { venuesOpened, tradesWritten };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:integration -- src/envioSync/runSyncV4.integration.test.ts`
Expected: PASS 1/1. If the `notExists`/subquery Drizzle syntax doesn't compile or doesn't behave as expected, use `superpowers:systematic-debugging` — this is exactly the kind of interface risk flagged for real resolution during execution, not a guess to lock in here. A simpler fallback if `notExists` proves awkward: fetch all graduated transitions, fetch all existing `v4_pool` venues' token addresses into a `Set`, and filter in application code instead of in SQL — functionally equivalent, simpler to get right.

- [ ] **Step 5: Document the new env vars**

Append to `be/.env.example`:

```
# Envio sync layer — Phase 3 (Pons V2 → V4). Same ENVIO_DATABASE_URL as Phase 1/2.
# ENVIO_RAW_V4_INITIALIZE_TABLE=envio."RawV4Initialize"
# ENVIO_RAW_V4_SWAP_TABLE=envio."RawV4Swap"
```

- [ ] **Step 6: Commit**

```bash
git add src/envioSync/runSyncV4.ts src/envioSync/runSyncV4.integration.test.ts .env.example
git commit -m "feat: sync verified Pons V4 pool venues and swaps into staging, idempotently

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Extend the sync and comparison CLIs for V4

**Files:**
- Modify: `be/src/cli/syncEnvioStaging.ts`
- Modify: `be/src/cli/compareEnvioStaging.ts`
- Modify: root `README.md`

**Interfaces:**
- Consumes: `syncV4Once`, `DEFAULT_ENVIO_V4_TABLES` from Task 5.
- Produces: nothing new for later tasks — this is Phase 3's final integration point.

- [ ] **Step 1: Extend the sync CLI to also run V4, after V2**

Modify `be/src/cli/syncEnvioStaging.ts` — `syncV4Once` must run *after* `syncV2Once` in the same invocation, since it depends on Phase 2's graduated lifecycle transitions and curve venues already being in staging:

```typescript
import { syncV4Once, DEFAULT_ENVIO_V4_TABLES } from '../envioSync/runSyncV4.js';
```

(add alongside the existing `runSync.js`/`runSyncV2.js` imports)

```typescript
const v4Tables = {
  rawV4InitializeTable: process.env.ENVIO_RAW_V4_INITIALIZE_TABLE ?? DEFAULT_ENVIO_V4_TABLES.rawV4InitializeTable,
  rawV4SwapTable: process.env.ENVIO_RAW_V4_SWAP_TABLE ?? DEFAULT_ENVIO_V4_TABLES.rawV4SwapTable,
};
```

(add alongside the existing `v1Tables`/`v2Tables` declarations, before the `try` block)

```typescript
  const v4Result = await syncV4Once(envioPool, db, v4Tables);
  console.log('Synced V4 from Envio into staging:', v4Result);
```

(add inside the `try` block, immediately after the existing `v2Result` logging)

- [ ] **Step 2: Extend the compare CLI for V4 venues/trades**

Modify `be/src/cli/compareEnvioStaging.ts` — add to the shared `../db/schema.js` import line (`venues` is already imported):

```typescript
import { launches, trades, venues, launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitions, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
```

stays the same (no new table needed — V4 reuses `venuesEnvioStaging`/`tradesEnvioStaging`). Append before the `finally` block:

```typescript
  const realV4Trades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex })
    .from(trades).innerJoin(venues, eq(trades.venueId, venues.id))
    .where(and(eq(trades.chainId, 4663), eq(venues.kind, 'v4_pool')));
  const stagingV4Trades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex })
    .from(tradesEnvioStaging).innerJoin(venuesEnvioStaging, eq(tradesEnvioStaging.venueId, venuesEnvioStaging.id))
    .where(eq(venuesEnvioStaging.kind, 'v4_pool'));
  const v4TradeDiff = compareTradeCounts(realV4Trades, stagingV4Trades);
  console.log('V4 swaps — matching:', v4TradeDiff.matching, 'only in real:', v4TradeDiff.onlyInReal.length, 'only in staging:', v4TradeDiff.onlyInStaging.length);
```

Real V4 venues are keyed by `kind = 'v4_pool'` directly (not a `sourceId` string like `pons-v2`/`pons-v1-legacy`, since the real pipeline's V4 pool sources are per-pool, `pons-v2-v4:<poolId>` — matching by venue `kind` instead sidesteps needing to enumerate them).

- [ ] **Step 3: Typecheck and lint**

```bash
cd be && npx tsc --noEmit && npm run lint
```

Expected: both clean.

- [ ] **Step 4: Run the full `be` test suite, including a fresh-database check**

```bash
cd be && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration
```

Then, matching the discipline the Phase 2 final review established (its own in-session verification missed a real cross-file race because it never tested against a genuinely fresh database), create one throwaway fresh database and run the integration suite against it directly:

```bash
docker exec launchpad-aggregator-postgres-1 psql -U launchpad -d launchpad -c "CREATE DATABASE launchpad_phase3check_test;"
TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_phase3check_test npm run test:integration
docker exec launchpad-aggregator-postgres-1 psql -U launchpad -d launchpad -c "DROP DATABASE launchpad_phase3check_test;"
```

Expected: all green in both the existing and the fresh database.

- [ ] **Step 5: Update README**

Extend the existing Envio section's heading and content to mention Phase 3:

```markdown
### Envio HyperIndex — thử nghiệm Phase 1 + Phase 2 + Phase 3 (Pons V1-legacy, V2 launch/curve/lifecycle, V4 pool verification/swap)
```

Add one line after the existing paragraph:

```markdown
`sync:envio-staging`/`compare:envio-staging` giờ đồng bộ và đối chiếu cả V1-legacy, V2, lẫn V4
(mở venue V4 đã xác thực + swap chính thức) trong cùng một lần chạy — xem
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase3.md`.
```

- [ ] **Step 6: Commit**

```bash
cd be && git add src/cli/syncEnvioStaging.ts src/cli/compareEnvioStaging.ts
cd .. && git add README.md
git commit -m "feat: extend the Envio sync/compare CLIs to cover Pons V4

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After this plan

V1-legacy, V2 (launch/curve/lifecycle), and V4 (verified pool + official swaps) all now flow through the same Envio pipeline, matching the RPC-scan pipeline's full official-venue lifecycle: curve → (swept) → (graduated + verified V4 pool) → V4 swaps. Per the spec's phased rollout, the remaining steps are no longer about adding more Pons coverage — they are: (1) the real parallel-run comparison against the live custom indexer (spec §6), using `compare:envio-staging`'s now-complete V1+V2+V4 coverage; (2) establishing Envio's actual reorg-recovery behavior through real experimentation (spec §5, explicitly deferred by every phase so far); (3) cutover (staging tables become the real tables, or the sync layer starts writing directly to them); (4) retiring the custom indexer. Each of those is a different kind of work (operational validation and a live cutover, not new decode logic) and needs its own plan — and, per CLAUDE.md's own rule, a cutover touches live-serving data/infrastructure, which is exactly the kind of side effect that needs the user's explicit go-ahead before starting, not a continuation of this plan's own automatic-execution authorization.
