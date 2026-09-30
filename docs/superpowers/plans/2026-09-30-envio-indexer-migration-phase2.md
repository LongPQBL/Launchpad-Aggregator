# Envio HyperIndex Migration — Phase 2 (Pons V2 launch + curve + lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the same self-hosted Envio project from Phase 1 to also index Pons V2: the V2 factory's `TokenLaunched` and its three lifecycle events (`LaunchSwept`, `PoolGraduated`, `LaunchGraduationRescued`), plus the bonding curve's `CurveBuy`/`CurveSell`/`BuybackLocked` events (dynamically registered per launch), reimplemented in the sync layer and verified against the project's existing fully-audited `pons-v2-graduated.json` fixture.

**Architecture:** Same shape as Phase 1 — Envio's `config.yaml`/`schema.graphql`/handlers grow to cover V2's static factory contract (one more `contracts:` entry, same address as `pons-v2` in `sourceRegistry.ts`) and a dynamically-registered curve contract (same `contractRegister` pattern Phase 1 used for V3 pools). The sync layer grows a parallel `transformV2.ts`/`runSyncV2.ts`, writing into the *existing* `launches_envio_staging`/`venues_envio_staging`/`trades_envio_staging` tables (their shape is version-agnostic) plus one new `lifecycle_transitions_envio_staging` table.

**Tech Stack:** Same as Phase 1 — Envio HyperIndex (self-hosted), Node.js >=24, TypeScript, Drizzle, `pg`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md` (already covers V2's business rules — curve until sweep, then verified V4 pool; this plan implements the curve/lifecycle half only, matching the spec's own phased rollout in section 8).

## Global Constraints

- Same as Phase 1's Global Constraints (`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase1.md`): self-hosted only, real tables/API/frontend untouched, lowercase addresses, exact `(blockNumber, logIndex)` ordering, `null` never a faked value, Vietnamese docs / English code, Node >=24, never commit secrets.
- **No V4 in this phase.** `PoolGraduated` is decoded here only as a lifecycle-transition event (`phase: 2, kind: 'graduated'`) — it is *not* a trigger for V4 pool registration or verification. V4 pool ID derivation, `PoolGraduated`+`Initialize` same-tx matching, and V4 `Swap` indexing are Phase 3's job (`be/src/launchpads/pons/v2/poolKey.ts`, `v4Swaps.ts` — read only, not touched in this phase).
- **Curve trade price stays `null`, matching current production behavior.** `be/src/launchpads/pons/v2/adapter.ts`'s `decodeV2CurveBatch` (the function the live RPC-scan indexer actually calls) never passes `verifiedPostTradeReserves` into `decodeCurveTrade`/`decodeCurveBuyback` — confirmed via `grep -rn "verifiedPostTradeReserves" src/` finding zero call sites passing a real value. So real V2 curve trades in production today always have `priceNumeratorRaw`/`priceDenominatorRaw` as `null`. This phase's sync layer matches that exactly — it does not attempt curve-reserve replay reconstruction, which would need the curve's initial reserves at launch (a value nothing in the current codebase sources).
- `launches_envio_staging`/`venues_envio_staging`/`trades_envio_staging` (Phase 1) are reused as-is for V2 rows (`protocolVersion: 'v2'`, `kind: 'curve'`) — no new tables for those three.

## Review Focus

- **V2's quote asset isn't always the same token.** Unlike V1 (always WETH), V2's `pairToken` is emitted per-launch in the `TokenLaunched` event and can even be the zero address (native ETH) per `resolveV2QuoteAsset` in the RPC-scan adapter. Task 3's transform must carry the event's own `pairToken`, not hardcode WETH.
- **Lifecycle events share one factory address with launches.** All four V2 factory events (`TokenLaunched`, `LaunchSwept`, `PoolGraduated`, `LaunchGraduationRescued`) come from the *same* contract address — a handler that filters by event name incorrectly (e.g. treats every factory log as a launch) would misclassify lifecycle transitions as launches or vice versa. Task 1's live verification checks all three lifecycle kinds land with the right `kind`/`phase`, not just that *some* row appears.
- **Curve trade side/amount mapping must not swap buy and sell.** `CurveBuy`'s `tokensOut`/`quoteIn` and `CurveSell`'s `tokensIn`/`quoteOut` are asymmetric field names carrying the same *role* (token leg, quote leg) — a copy-paste error mapping `CurveSell`'s `tokensIn` into a `quoteAmountRaw` field would silently invert every sell's economics. Task 3's cross-check test covers a sell, not just a buy (Phase 1's V1 swap test only had a buy — this plan closes that gap for the trade math it owns).
- **Buyback is a distinct activity kind, not a regular trade.** `BuybackLocked` must land as `activityKind: 'protocol_buyback'`, matching `decodeCurveBuyback`'s existing behavior, not `'user_trade'` — CLAUDE.md requires protocol activity to carry its own label rather than being silently counted as a normal trade.
- **A rescued launch's lifecycle transition must not be silently dropped.** `LaunchGraduationRescued` (`phase: 3, kind: 'rescued'`) is the least common of the three lifecycle events and easy to under-test if only the fixture's `graduated` path is checked — Task 1's live verification and Task 4's transform test both exercise all three kinds, not just `graduated`.

---

## Task 1: Pons V2 factory — `TokenLaunched` + lifecycle events

**Files:**
- Modify: `envio/config.yaml`
- Modify: `envio/schema.graphql`
- Modify: `envio/src/EventHandlers.ts`

**Interfaces:**
- Consumes: nothing new from Phase 1 (adds a sibling static contract, does not touch `PonsV1LegacyFactory`/`PonsV3Pool`).
- Produces: `envio."RawLaunchV2"` (columns: `id`, `chainId`, `tokenAddress`, `curveAddress`, `deployerAddress`, `pairTokenAddress`, `blockNumber`, `blockHash`, `txHash`, `logIndex`) and `envio."RawLifecycleTransition"` (columns: `id`, `chainId`, `tokenAddress`, `phase`, `kind`, `blockNumber`, `blockHash`, `txHash`, `logIndex`) — Task 3/4's transform functions consume exactly these shapes.

- [ ] **Step 1: Add the V2 factory contract and its four events to `config.yaml`**

Add to the existing `contracts:` list and `chains[0].contracts:` list (full file, extending Phase 1's version):

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
```

`name: TokenLaunchedV2` on the V2 `TokenLaunched` event disambiguates it from V1's own `TokenLaunched` (different signature, but Envio's per-contract event registry needs a unique handler key when two contracts each declare an event of the same name — confirmed necessary via the `indexer-configuration` skill's "Custom Event Names" section, copied into `envio/.claude/skills/` in Phase 1).

- [ ] **Step 2: Add the V2 entities to `schema.graphql`**

Append to the existing file (after `RawSwap`):

```graphql
type RawLaunchV2 {
  id: ID!
  chainId: Int!
  tokenAddress: String!
  curveAddress: String!
  deployerAddress: String!
  pairTokenAddress: String!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
}

type RawLifecycleTransition {
  id: ID!
  chainId: Int!
  tokenAddress: String!
  phase: Int!
  kind: String!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
}
```

- [ ] **Step 3: Add the four V2 factory handlers**

Append to `envio/src/EventHandlers.ts`:

```typescript
indexer.onEvent(
  { contract: "PonsV2Factory", event: "TokenLaunchedV2" },
  async ({ event, context }) => {
    context.RawLaunchV2.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      curveAddress: event.params.curve.toLowerCase(),
      deployerAddress: event.params.deployer.toLowerCase(),
      pairTokenAddress: event.params.pairToken.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "LaunchSwept" },
  async ({ event, context }) => {
    context.RawLifecycleTransition.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      phase: 1,
      kind: "swept",
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "PoolGraduated" },
  async ({ event, context }) => {
    context.RawLifecycleTransition.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      phase: 2,
      kind: "graduated",
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "LaunchGraduationRescued" },
  async ({ event, context }) => {
    context.RawLifecycleTransition.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      phase: 3,
      kind: "rescued",
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);
```

- [ ] **Step 4: Codegen and typecheck**

```bash
cd envio && pnpm codegen && npx tsc --noEmit
```

Expected: both succeed. If `tsc` reports a type error, apply the real-compiler-feedback loop established in Phase 1 (inspect `envio/.envio/types.d.ts`, fix, re-run) — do not guess past what the generated types show.

- [ ] **Step 5: Clean-volume restart and run past the fixture blocks**

```bash
docker compose down -v && docker compose up -d --build
```

Wait until the indexer's logs show it has passed block `27828161` (the fixture's highest V2 block, `graduation`) — it will be indexing from `8600612` again so this takes longer than a single-source run; poll by querying `envio."RawLifecycleTransition"` for the graduation row (see Step 6) rather than watching logs line-by-line. Then:

```bash
docker compose stop envio-indexer
```

- [ ] **Step 6: Verify all four fixture events landed correctly**

```bash
docker exec envio-envio-postgres-1 psql -U postgres -d envio-dev -c \
  'SELECT "tokenAddress", "curveAddress", "deployerAddress", "pairTokenAddress", "blockNumber", "logIndex" FROM envio."RawLaunchV2" WHERE "txHash" = '"'"'0xd7b79e93a733b14976e964215ecca560903ac4be818b48b08dabbef5e8b45ab6'"'"';'
docker exec envio-envio-postgres-1 psql -U postgres -d envio-dev -c \
  'SELECT "tokenAddress", phase, kind, "blockNumber", "logIndex" FROM envio."RawLifecycleTransition" WHERE "txHash" IN ('"'"'0xcdf59f4c62cf50d8fdfefc984fa25ffb5aa797ee4fd06cfef30bf0b1afc15f3f'"'"', '"'"'0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3'"'"') ORDER BY "blockNumber";'
```

Expected: the first query returns exactly one row — `tokenAddress = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29'`, `curveAddress = '0x94fd7acd1830065468ce50179f1f18a053586139'`, `deployerAddress = '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2'`, `pairTokenAddress = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'`, `blockNumber = 27823666`, `logIndex = 30` — matching `be/tests/fixtures/pons-v2-graduated.json`'s `launch` block exactly (these exact lowercase values were independently decoded from the fixture via `decodeEventLog` during this plan's own preparation — not hand-parsed hex). The second query returns exactly two rows: `(tokenAddress='0xc9e9ab90654f82893d7fd18b62f694992e8cef29', phase=1, kind='swept', blockNumber=27823772, logIndex=52)` and `(phase=2, kind='graduated', blockNumber=27828161, logIndex=36)`.

- [ ] **Step 7: Commit**

```bash
git add envio/config.yaml envio/schema.graphql envio/src/
git commit -m "feat: index Pons V2 TokenLaunched and lifecycle events via Envio, verified against the graduated fixture

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Dynamically register V2 curves and index their trade/buyback events

**Files:**
- Modify: `envio/config.yaml` (already added `PonsV2Curve`'s event list in Task 1 — this task adds the dynamic registration and `chains[0].contracts` entry's absence-of-address, already present from Task 1 Step 1's full file)
- Modify: `envio/schema.graphql`
- Modify: `envio/src/EventHandlers.ts`

**Interfaces:**
- Consumes: Task 1's `PonsV2Factory`/`TokenLaunchedV2` handler (adds a `contractRegister` alongside it).
- Produces: `envio."RawCurveTrade"` (columns: `id`, `chainId`, `curveAddress`, `side`, `tokenAmountRaw`, `quoteAmountRaw`, `feeRaw`, `taxRaw`, `txFrom`, `blockNumber`, `blockHash`, `txHash`, `logIndex`, `timestamp`) and `envio."RawCurveBuyback"` (columns: `id`, `chainId`, `curveAddress`, `quoteSpentRaw`, `tokensLockedRaw`, `blockNumber`, `blockHash`, `txHash`, `logIndex`, `timestamp`) — Task 3 consumes exactly these shapes.

`PonsV2Curve` has no `address:` under `chains[0].contracts` in Task 1's config — already set up as a dynamically-registered contract, same as Phase 1's `PonsV3Pool`.

- [ ] **Step 1: Add `contractRegister` for the curve**

Append to `envio/src/EventHandlers.ts`:

```typescript
indexer.contractRegister(
  { contract: "PonsV2Factory", event: "TokenLaunchedV2" },
  async ({ event, context }) => {
    context.chain.PonsV2Curve.add(event.params.curve);
  },
);
```

- [ ] **Step 2: Add the `RawCurveTrade`/`RawCurveBuyback` entities**

Append to `envio/schema.graphql`:

```graphql
type RawCurveTrade {
  id: ID!
  chainId: Int!
  curveAddress: String!
  side: String!
  tokenAmountRaw: BigInt!
  quoteAmountRaw: BigInt!
  feeRaw: BigInt!
  taxRaw: BigInt!
  txFrom: String!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
  timestamp: Int!
}

type RawCurveBuyback {
  id: ID!
  chainId: Int!
  curveAddress: String!
  quoteSpentRaw: BigInt!
  tokensLockedRaw: BigInt!
  blockNumber: BigInt!
  blockHash: String!
  txHash: String!
  logIndex: Int!
  timestamp: Int!
}
```

`RawCurveTrade` unifies `CurveBuy`/`CurveSell` into one entity with a `side` field and a common `tokenAmountRaw`/`quoteAmountRaw` shape (mapping `CurveBuy.tokensOut`→`tokenAmountRaw`/`CurveBuy.quoteIn`→`quoteAmountRaw`, `CurveSell.tokensIn`→`tokenAmountRaw`/`CurveSell.quoteOut`→`quoteAmountRaw`), matching how `decodeCurveTrade` in `be/src/launchpads/pons/v2/adapter.ts` already treats both events as one shape — the Envio layer does this mapping instead of the sync layer re-deciding which field means what per event name.

- [ ] **Step 3: Add the `CurveBuy`/`CurveSell`/`BuybackLocked` handlers**

`txFrom` (not `buyer`/`seller`) is the trader — the real RPC-scan pipeline's `decodeV2CurveBatch` already sources the trader from `data.traders.get(log.transactionHash)` (the transaction's `from`), not from the event's own `buyer`/`seller` param, confirmed by reading `be/src/launchpads/pons/v2/adapter.ts:200-207`. Same principle as Phase 1's `RawSwap.txFrom` fix.

Append to `envio/src/EventHandlers.ts`:

```typescript
indexer.onEvent(
  { contract: "PonsV2Curve", event: "CurveBuy" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for curve buy ${event.transaction.hash}`);
    context.RawCurveTrade.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      curveAddress: event.srcAddress.toLowerCase(),
      side: "buy",
      tokenAmountRaw: event.params.tokensOut,
      quoteAmountRaw: event.params.quoteIn,
      feeRaw: event.params.fee,
      taxRaw: event.params.tax,
      txFrom: event.transaction.from.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Curve", event: "CurveSell" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for curve sell ${event.transaction.hash}`);
    context.RawCurveTrade.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      curveAddress: event.srcAddress.toLowerCase(),
      side: "sell",
      tokenAmountRaw: event.params.tokensIn,
      quoteAmountRaw: event.params.quoteOut,
      feeRaw: event.params.fee,
      taxRaw: event.params.tax,
      txFrom: event.transaction.from.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Curve", event: "BuybackLocked" },
  async ({ event, context }) => {
    context.RawCurveBuyback.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      curveAddress: event.srcAddress.toLowerCase(),
      quoteSpentRaw: event.params.quoteSpent,
      tokensLockedRaw: event.params.tokensLocked,
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);
```

- [ ] **Step 4: Codegen, typecheck, clean-volume restart, run past the fixture curve-buy block**

```bash
cd envio && pnpm codegen && npx tsc --noEmit
docker compose down -v && docker compose up -d --build
```

Wait until indexing has passed block `27823668`, confirm the curve `0x94fd7acd1830065468ce50179f1f18a053586139` was registered via `contractRegister` (check the indexer's logs for `numContractRegisterEvents`, same as Phase 1 Task 3), then:

```bash
docker compose stop envio-indexer
```

- [ ] **Step 5: Verify the fixture curve buy landed correctly**

```bash
docker exec envio-envio-postgres-1 psql -U postgres -d envio-dev -c \
  'SELECT "curveAddress", side, "tokenAmountRaw", "quoteAmountRaw", "feeRaw", "taxRaw", "blockNumber", "logIndex" FROM envio."RawCurveTrade" WHERE "txHash" = '"'"'0x8147b8c06a405cd1d5314c16a25c86a0ba3aea64e490547e60afdbbff534cc28'"'"';'
```

Expected: exactly one row — `curveAddress = '0x94fd7acd1830065468ce50179f1f18a053586139'`, `side = 'buy'`, `tokenAmountRaw = 20552501950319369479600566`, `quoteAmountRaw = 352696917677647859`, `feeRaw = 3526969176776478`, `taxRaw = 0`, `blockNumber = 27823668`, `logIndex = 19` — these exact values were independently decoded from `be/tests/fixtures/pons-v2-graduated.json`'s `curveBuy` block during this plan's preparation.

- [ ] **Step 6: Commit**

```bash
git add envio/config.yaml envio/schema.graphql envio/src/
git commit -m "feat: dynamically register V2 curves and index their trade/buyback events via Envio

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Sync-layer transform functions for V2 launch and curve trades

**Files:**
- Create: `be/src/envioSync/transformV2.ts`
- Create: `be/src/envioSync/transformV2.test.ts`

**Interfaces:**
- Consumes: `hydrateV2Launch`, `V2LaunchEvent`, `V2LaunchRecord`, `V2LaunchWithVenue` from `be/src/launchpads/pons/v2/adapter.js`; `Launch`, `Trade`, `Venue` from `be/src/domain/types.js`; `logKey` from `be/src/domain/ids.js`; the `pons-v2` `FactorySource` from `be/src/launchpads/pons/sourceRegistry.js`.
- Produces: `envioRawLaunchV2ToEvent(row: EnvioRawLaunchV2Row): V2LaunchEvent`, `hydrateV2LaunchFromEnvio(event: V2LaunchEvent, factory: FactorySource): V2LaunchWithVenue`, `hydrateCurveTradeFromDecoded(row: EnvioRawCurveTradeRow, venue: Venue, launch: Launch): Trade`, `hydrateCurveBuybackFromDecoded(row: EnvioRawCurveBuybackRow, venue: Venue, launch: Launch): Trade` — Task 5's sync script consumes all four.

- [ ] **Step 1: Write the failing cross-check test for the V2 launch mapper**

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { decodeV2Launch } from '../launchpads/pons/v2/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, type EnvioRawLaunchV2Row } from './transformV2.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const v2Factory = getPonsFactorySources()[2];

interface RpcLogLike { address: Address; topics: readonly Hash[]; data: Hash; blockNumber: bigint; blockHash: Hash; transactionHash: Hash; logIndex: number }

function asLog(raw: Record<string, unknown>): RpcLogLike {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number),
    blockHash: raw.blockHash as Hash,
    transactionHash: raw.transactionHash as Hash,
    logIndex: Number(raw.logIndex),
  };
}

describe('envioRawLaunchV2ToEvent', () => {
  it('produces the same V2LaunchEvent as decoding the raw log directly', () => {
    const expected = decodeV2Launch(asLog(fixture.launch as Record<string, unknown>), v2Factory);
    const row: EnvioRawLaunchV2Row = {
      chainId: 4663,
      tokenAddress: fixture.tokenAddress as string,
      curveAddress: fixture.curveAddress as string,
      deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2',
      pairTokenAddress: fixture.quoteAddress as string,
      blockNumber: 27823666n,
      blockHash: (fixture.launch as Record<string, unknown>).blockHash as string,
      txHash: (fixture.launch as Record<string, unknown>).transactionHash as string,
      logIndex: 30,
    };
    const event = envioRawLaunchV2ToEvent(row);
    expect(event).toEqual(expected);
  });
});

describe('hydrateV2LaunchFromEnvio', () => {
  it('produces a Launch/Venue pair with the event as the sole source of truth (no RPC record needed)', () => {
    const row: EnvioRawLaunchV2Row = {
      chainId: 4663,
      tokenAddress: fixture.tokenAddress as string,
      curveAddress: fixture.curveAddress as string,
      deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2',
      pairTokenAddress: fixture.quoteAddress as string,
      blockNumber: 27823666n,
      blockHash: (fixture.launch as Record<string, unknown>).blockHash as string,
      txHash: (fixture.launch as Record<string, unknown>).transactionHash as string,
      logIndex: 30,
    };
    const event = envioRawLaunchV2ToEvent(row);
    const { launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory);
    expect(launch.tokenAddress).toBe(fixture.tokenAddress as string);
    expect(launch.protocolVersion).toBe('v2');
    expect(launch.quoteAsset.address).toBe(fixture.quoteAddress as string);
    expect(launch.name).toBeNull();
    expect(launch.symbol).toBeNull();
    expect(venue.kind).toBe('curve');
    expect(venue.ref).toBe(fixture.curveAddress as string);
    expect(venue.official).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformV2.test.ts`
Expected: FAIL — `Cannot find module './transformV2.js'`.

- [ ] **Step 3: Write `envioRawLaunchV2ToEvent` and `hydrateV2LaunchFromEnvio`**

```typescript
import type { Address, Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import { hydrateV2Launch, type V2LaunchEvent, type V2LaunchRecord, type V2LaunchWithVenue } from '../launchpads/pons/v2/adapter.js';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';

export interface EnvioRawLaunchV2Row {
  chainId: number;
  tokenAddress: string;
  curveAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export function envioRawLaunchV2ToEvent(row: EnvioRawLaunchV2Row): V2LaunchEvent {
  return {
    tokenAddress: row.tokenAddress.toLowerCase() as Address,
    curveAddress: row.curveAddress.toLowerCase() as Address,
    deployerAddress: row.deployerAddress.toLowerCase() as Address,
    pairToken: row.pairTokenAddress.toLowerCase() as Address,
    blockNumber: row.blockNumber,
    transactionHash: row.txHash.toLowerCase() as Hash,
    sourceLogId: logKey(row.chainId, row.blockHash.toLowerCase() as Hash, row.txHash.toLowerCase() as Hash, row.logIndex),
  };
}

// hydrateV2Launch (be/src/launchpads/pons/v2/adapter.ts) validates its `record`/`metadata`/`quoteAsset`
// params against the event, sourced from factory-state RPC reads in the RPC-scan path. This phase's
// sync layer has no RPC calls (same scope decision as Phase 1's V1 launch handling), so the "record"
// is synthesized from the event's own fields as ground truth — this makes hydrateV2Launch's
// record-matches-event check a structural no-op here, same documented tradeoff as Phase 1's
// liquidityPool bypass. poolFee/tickSpacing are placeholders unused by this phase (no V4 logic here);
// Phase 3 will source real values directly from the V4 pool's own Initialize event instead of this
// placeholder. name/symbol/decimals are placeholders too — overwritten with null at the staging
// insert layer (see runSyncV2.ts), matching Phase 1's "null means unavailable" convention.
export function hydrateV2LaunchFromEnvio(event: V2LaunchEvent, factory: FactorySource): V2LaunchWithVenue {
  const record: V2LaunchRecord = {
    token: event.tokenAddress, curve: event.curveAddress, deployer: event.deployerAddress,
    pairToken: event.pairToken, poolFee: 0, tickSpacing: 60, phase: 0, exists: true,
  };
  return hydrateV2Launch(event, factory, record, { name: '', symbol: '', decimals: 18 },
    { address: event.pairToken, symbol: '', decimals: 18 });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformV2.test.ts`
Expected: PASS 2/2.

- [ ] **Step 5: Write the failing cross-check test for curve trade math (buy, sell, and buyback)**

Append to the same test file:

```typescript
import { decodeCurveTrade } from '../launchpads/pons/v2/adapter.js';
import { hydrateCurveTradeFromDecoded, hydrateCurveBuybackFromDecoded, type EnvioRawCurveTradeRow, type EnvioRawCurveBuybackRow } from './transformV2.js';

const { launch, venue } = hydrateV2LaunchFromEnvio(
  envioRawLaunchV2ToEvent({
    chainId: 4663, tokenAddress: fixture.tokenAddress as string, curveAddress: fixture.curveAddress as string,
    deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2', pairTokenAddress: fixture.quoteAddress as string,
    blockNumber: 27823666n, blockHash: (fixture.launch as Record<string, unknown>).blockHash as string,
    txHash: (fixture.launch as Record<string, unknown>).transactionHash as string, logIndex: 30,
  }),
  v2Factory,
);
const curveTrader = '0x1234567890123456789012345678901234567890' as Address;

describe('hydrateCurveTradeFromDecoded', () => {
  it('produces the same Trade as decoding the real fixture CurveBuy log directly', () => {
    // decodeCurveTrade's 6th arg (verifiedPostTradeReserves) is omitted here, same as the real
    // RPC-scan pipeline's decodeV2CurveBatch call site — both paths produce null price this way,
    // which is exactly the equivalence this cross-check needs to prove (see this plan's Global
    // Constraints on curve trade price staying null).
    const expected = decodeCurveTrade(asLog(fixture.curveBuy as Record<string, unknown>), launch, venue, 1_700_000_000, curveTrader);
    const row: EnvioRawCurveTradeRow = {
      curveAddress: fixture.curveAddress as string,
      side: 'buy',
      tokenAmountRaw: 20552501950319369479600566n,
      quoteAmountRaw: 352696917677647859n,
      feeRaw: 3526969176776478n,
      taxRaw: 0n,
      txFrom: curveTrader,
      blockNumber: 27823668n,
      blockHash: (fixture.curveBuy as Record<string, unknown>).blockHash as string,
      txHash: (fixture.curveBuy as Record<string, unknown>).transactionHash as string,
      logIndex: 19,
      timestamp: 1_700_000_000,
    };
    const trade = hydrateCurveTradeFromDecoded(row, venue, launch);
    expect(trade).toEqual(expected);
    expect(trade.side).toBe('buy');
    expect(trade.priceNumeratorRaw).toBeNull();
    expect(trade.priceDenominatorRaw).toBeNull();
  });

  it('maps a CurveSell row without swapping the token/quote legs', () => {
    const row: EnvioRawCurveTradeRow = {
      curveAddress: fixture.curveAddress as string,
      side: 'sell',
      tokenAmountRaw: 500_000_000_000_000_000_000n,
      quoteAmountRaw: 9_000_000_000_000_000n,
      feeRaw: 90_000_000_000_000n,
      taxRaw: 0n,
      txFrom: '0x1234567890123456789012345678901234567890',
      blockNumber: 27827000n,
      blockHash: '0x' + 'c'.repeat(64),
      txHash: '0x' + '7'.repeat(64),
      logIndex: 3,
      timestamp: 1_700_000_100,
    };
    const trade = hydrateCurveTradeFromDecoded(row, venue, launch);
    expect(trade.side).toBe('sell');
    expect(trade.tokenAmountRaw).toBe(500_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(9_000_000_000_000_000n);
    expect(trade.sourceEvent).toBe('CurveSell');
  });
});

describe('hydrateCurveBuybackFromDecoded', () => {
  it('maps a BuybackLocked row to activityKind protocol_buyback, not user_trade', () => {
    const row: EnvioRawCurveBuybackRow = {
      curveAddress: fixture.curveAddress as string,
      quoteSpentRaw: 1_000_000_000_000_000_000n,
      tokensLockedRaw: 2_000_000_000_000_000_000n,
      blockNumber: 27827500n,
      blockHash: '0x' + 'd'.repeat(64),
      txHash: '0x' + '8'.repeat(64),
      logIndex: 7,
      timestamp: 1_700_000_200,
    };
    const trade = hydrateCurveBuybackFromDecoded(row, venue, launch);
    expect(trade.activityKind).toBe('protocol_buyback');
    expect(trade.side).toBe('buy');
    expect(trade.tokenAmountRaw).toBe(2_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformV2.test.ts`
Expected: FAIL — `hydrateCurveTradeFromDecoded`/`hydrateCurveBuybackFromDecoded` not exported.

- [ ] **Step 7: Write `hydrateCurveTradeFromDecoded` and `hydrateCurveBuybackFromDecoded`**

Append to `be/src/envioSync/transformV2.ts`:

```typescript
import type { Launch, Trade, Venue } from '../domain/types.js';

export interface EnvioRawCurveTradeRow {
  curveAddress: string;
  side: 'buy' | 'sell';
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  feeRaw: bigint;
  taxRaw: bigint;
  txFrom: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

export interface EnvioRawCurveBuybackRow {
  curveAddress: string;
  quoteSpentRaw: bigint;
  tokensLockedRaw: bigint;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

// Mirrors decodeCurveTrade's output shape (be/src/launchpads/pons/v2/adapter.ts) but Envio already
// decoded and side/leg-mapped the event (see envio/src/EventHandlers.ts's CurveBuy/CurveSell
// handlers), so there is no raw log to re-decode here. Price stays null — see this plan's Global
// Constraints (matches current production behavior, which never computes curve trade price either).
export function hydrateCurveTradeFromDecoded(row: EnvioRawCurveTradeRow, venue: Venue, launch: Launch): Trade {
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id,
    blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase() as `0x${string}`,
    txHash: row.txHash.toLowerCase() as `0x${string}`, logIndex: row.logIndex, timestamp: row.timestamp,
    side: row.side, tokenAmountRaw: row.tokenAmountRaw, quoteAmountRaw: row.quoteAmountRaw,
    quoteAssetAddress: launch.quoteAsset.address,
    sourceEvent: row.side === 'buy' ? 'CurveBuy' : 'CurveSell',
    activityKind: 'user_trade',
    priceNumeratorRaw: null, priceDenominatorRaw: null,
    traderAddress: row.txFrom.toLowerCase() as `0x${string}`,
  };
}

export function hydrateCurveBuybackFromDecoded(row: EnvioRawCurveBuybackRow, venue: Venue, launch: Launch): Trade {
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id,
    blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase() as `0x${string}`,
    txHash: row.txHash.toLowerCase() as `0x${string}`, logIndex: row.logIndex, timestamp: row.timestamp,
    side: 'buy', tokenAmountRaw: row.tokensLockedRaw, quoteAmountRaw: row.quoteSpentRaw,
    quoteAssetAddress: launch.quoteAsset.address, sourceEvent: 'BuybackLocked', activityKind: 'protocol_buyback',
    priceNumeratorRaw: null, priceDenominatorRaw: null,
    traderAddress: launch.factoryAddress.toLowerCase() as `0x${string}`,
  };
}
```

`BuybackLocked` has no buyer/trader param at all (it's protocol-initiated, not a user transaction in the same sense) — `traderAddress` is set to the factory address as a placeholder, matching that this is protocol activity, not a user's trade; the real RPC-scan `decodeCurveBuyback` does take a `traderAddress` parameter sourced from `data.traders.get(...)` (tx.from) in its own caller, so revisit this if a later plan needs buyback attribution — ledger this as a known simplification if not revisited before cutover.

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformV2.test.ts`
Expected: PASS 5/5.

- [ ] **Step 9: Commit**

```bash
git add src/envioSync/transformV2.ts src/envioSync/transformV2.test.ts
git commit -m "feat: reimplement Pons V2 launch/curve business logic for the Envio sync layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Sync-layer transform for lifecycle transitions

**Files:**
- Create: `be/src/envioSync/transformLifecycle.ts`
- Create: `be/src/envioSync/transformLifecycle.test.ts`

**Interfaces:**
- Consumes: `LifecycleTransition` from `be/src/domain/types.js`; `logKey` from `be/src/domain/ids.js`.
- Produces: `envioRawLifecycleToTransition(row: EnvioRawLifecycleRow, sourceId: string): LifecycleTransition` — Task 5's sync script consumes this.

- [ ] **Step 1: Write the failing test for all three lifecycle kinds**

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envioRawLifecycleToTransition, type EnvioRawLifecycleRow } from './transformLifecycle.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('envioRawLifecycleToTransition', () => {
  it('maps a swept row to phase 1', () => {
    const sweep = fixture.sweep as Record<string, unknown>;
    const row: EnvioRawLifecycleRow = {
      chainId: 4663, tokenAddress: fixture.tokenAddress as string, phase: 1, kind: 'swept',
      blockNumber: 27823772n, blockHash: sweep.blockHash as string,
      txHash: sweep.transactionHash as string, logIndex: 52,
    };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    expect(transition.phase).toBe(1);
    expect(transition.kind).toBe('swept');
    expect(transition.tokenAddress).toBe(fixture.tokenAddress as string);
    expect(transition.sourceId).toBe('pons-v2-lifecycle');
  });

  it('maps a graduated row to phase 2', () => {
    const graduation = fixture.graduation as Record<string, unknown>;
    const row: EnvioRawLifecycleRow = {
      chainId: 4663, tokenAddress: fixture.tokenAddress as string, phase: 2, kind: 'graduated',
      blockNumber: 27828161n, blockHash: graduation.blockHash as string,
      txHash: graduation.transactionHash as string, logIndex: 36,
    };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    expect(transition.phase).toBe(2);
    expect(transition.kind).toBe('graduated');
  });

  it('maps a rescued row to phase 3 (no fixture for this path — a synthetic but structurally valid row)', () => {
    const row: EnvioRawLifecycleRow = {
      chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', phase: 3, kind: 'rescued',
      blockNumber: 30_000_000n, blockHash: '0x' + 'e'.repeat(64),
      txHash: '0x' + '9'.repeat(64), logIndex: 1,
    };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    expect(transition.phase).toBe(3);
    expect(transition.kind).toBe('rescued');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/envioSync/transformLifecycle.test.ts`
Expected: FAIL — `Cannot find module './transformLifecycle.js'`.

- [ ] **Step 3: Write `envioRawLifecycleToTransition`**

```typescript
import type { Address, Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import type { LifecycleTransition } from '../domain/types.js';

export interface EnvioRawLifecycleRow {
  chainId: number;
  tokenAddress: string;
  phase: 1 | 2 | 3;
  kind: 'swept' | 'graduated' | 'rescued';
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export function envioRawLifecycleToTransition(row: EnvioRawLifecycleRow, sourceId: string): LifecycleTransition {
  return {
    chainId: row.chainId,
    tokenAddress: row.tokenAddress.toLowerCase() as Address,
    sourceId,
    sourceLogId: logKey(row.chainId, row.blockHash.toLowerCase() as Hash, row.txHash.toLowerCase() as Hash, row.logIndex),
    phase: row.phase,
    kind: row.kind,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash,
    logIndex: row.logIndex,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/envioSync/transformLifecycle.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/envioSync/transformLifecycle.ts src/envioSync/transformLifecycle.test.ts
git commit -m "feat: reimplement Pons V2 lifecycle-transition mapping for the Envio sync layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Staging schema extension and `syncV2Once`

**Files:**
- Modify: `be/src/db/schema.ts`
- Create: `be/src/envioSync/runSyncV2.ts`
- Create: `be/src/envioSync/runSyncV2.integration.test.ts`
- Modify: `be/.env.example`

**Interfaces:**
- Consumes: `envioRawLaunchV2ToEvent`, `hydrateV2LaunchFromEnvio`, `hydrateCurveTradeFromDecoded`, `hydrateCurveBuybackFromDecoded` from Task 3; `envioRawLifecycleToTransition` from Task 4; `DEFAULT_ENVIO_TABLES`-style table-name pattern from Phase 1's `runSync.ts`.
- Produces: `syncV2Once(envioPool: Pool, appDb: Database, tables?: EnvioV2TableNames): Promise<{ launchesWritten: number; tradesWritten: number; transitionsWritten: number }>` — Task 6's CLI extensions call this alongside Phase 1's `syncV1LegacyOnce`.

- [ ] **Step 1: Add the lifecycle staging table and loosen `launchesEnvioStaging.quoteAssetSymbol`**

In `be/src/db/schema.ts`, change `launchesEnvioStaging`'s `quoteAssetSymbol` field from `.notNull()` to nullable (V2's quote asset symbol is genuinely unknown without a metadata RPC call this phase doesn't make, same reasoning as `name`/`symbol` already nullable from Phase 1's fix pass):

```typescript
  quoteAssetSymbol: text('quote_asset_symbol'),
```

Append a new table after `tradesEnvioStaging`:

```typescript
export const lifecycleTransitionsEnvioStaging = pgTable('lifecycle_transitions_envio_staging', {
  sourceLogId: text('source_log_id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  phase: integer('phase').notNull(),
  kind: text('kind').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
});
```

- [ ] **Step 2: Generate and review the migration**

```bash
cd be && npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` with one `CREATE TABLE` (the new lifecycle table) and one `ALTER COLUMN ... DROP NOT NULL` (the loosened `quoteAssetSymbol`) — both additive/safe. Read the file to confirm.

- [ ] **Step 3: Apply it to the test database**

```bash
DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate
```

(If `launches_envio_staging` has leftover rows from earlier manual testing, `TRUNCATE` it first — this is throwaway test data, not user data.)

- [ ] **Step 4: Write the failing integration test for `syncV2Once`**

```typescript
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { syncV2Once } from './runSyncV2.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = {
  rawLaunchV2Table: 'envio_fixture."RawLaunchV2"',
  rawCurveTradeTable: 'envio_fixture."RawCurveTrade"',
  rawCurveBuybackTable: 'envio_fixture."RawCurveBuyback"',
  rawLifecycleTable: 'envio_fixture."RawLifecycleTransition"',
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawLaunchV2" (
    id text primary key, "chainId" int, "tokenAddress" text, "curveAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawCurveTrade" (
    id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric,
    "quoteAmountRaw" numeric, "feeRaw" numeric, "taxRaw" numeric, "txFrom" text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawCurveBuyback" (
    id text primary key, "chainId" int, "curveAddress" text, "quoteSpentRaw" numeric, "tokensLockedRaw" numeric,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawLifecycleTransition" (
    id text primary key, "chainId" int, "tokenAddress" text, phase int, kind text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
});

beforeEach(async () => {
  await pool.query('TRUNCATE launches_envio_staging, venues_envio_staging, trades_envio_staging, lifecycle_transitions_envio_staging');
  await envioPool.query('TRUNCATE envio_fixture."RawLaunchV2", envio_fixture."RawCurveTrade", envio_fixture."RawCurveBuyback", envio_fixture."RawLifecycleTransition"');
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('syncV2Once', () => {
  it('writes a launch, a curve trade, and a lifecycle transition, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture."RawLaunchV2" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['l2', 4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', '0x94fd7acd1830065468ce50179f1f18a053586139',
        '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2', '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
        '27823666', '0x7b69362e91d3247bf46d43fc07569b43abfbb219f31dcc0e897e13ff49762eba',
        '0xd7b79e93a733b14976e964215ecca560903ac4be818b48b08dabbef5e8b45ab6', 30],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture."RawCurveTrade" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      ['t2', 4663, '0x94fd7acd1830065468ce50179f1f18a053586139', 'buy',
        '20552501950319369479600566', '352696917677647859', '3526969176776478', '0',
        '0x1234567890123456789012345678901234567890',
        '27823668', '0xbaa41185b64193502af49abb8f14b3a178042291804605300f358969d3a8fa2e',
        '0x8147b8c06a405cd1d5314c16a25c86a0ba3aea64e490547e60afdbbff534cc28', 19, 1_700_000_000],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture."RawLifecycleTransition" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ['g2', 4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', 2, 'graduated',
        '27828161', '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e',
        '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3', 36],
    );

    const first = await syncV2Once(envioPool, db, fixtureTables);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 });
    expect(await db.select().from(launchesEnvioStaging)).toHaveLength(1);
    expect(await db.select().from(venuesEnvioStaging)).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging)).toHaveLength(1);
    const transitions = await db.select().from(lifecycleTransitionsEnvioStaging);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe('graduated');

    const second = await syncV2Once(envioPool, db, fixtureTables);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0, transitionsWritten: 0 });
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test:integration -- src/envioSync/runSyncV2.integration.test.ts`
Expected: FAIL — `Cannot find module './runSyncV2.js'`.

- [ ] **Step 6: Write `runSyncV2.ts`**

```typescript
import type { Pool } from 'pg';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Database } from '../db/client.js';
import type { Launch, Venue } from '../domain/types.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, hydrateCurveTradeFromDecoded, hydrateCurveBuybackFromDecoded,
  type EnvioRawLaunchV2Row, type EnvioRawCurveTradeRow, type EnvioRawCurveBuybackRow } from './transformV2.js';
import { envioRawLifecycleToTransition, type EnvioRawLifecycleRow } from './transformLifecycle.js';

const v2Factory = getPonsFactorySources()[2];

export interface EnvioV2TableNames {
  rawLaunchV2Table: string;
  rawCurveTradeTable: string;
  rawCurveBuybackTable: string;
  rawLifecycleTable: string;
}

export const DEFAULT_ENVIO_V2_TABLES: EnvioV2TableNames = {
  rawLaunchV2Table: 'envio."RawLaunchV2"',
  rawCurveTradeTable: 'envio."RawCurveTrade"',
  rawCurveBuybackTable: 'envio."RawCurveBuyback"',
  rawLifecycleTable: 'envio."RawLifecycleTransition"',
};

export async function syncV2Once(
  envioPool: Pool,
  appDb: Database,
  tables: EnvioV2TableNames = DEFAULT_ENVIO_V2_TABLES,
): Promise<{ launchesWritten: number; tradesWritten: number; transitionsWritten: number }> {
  const rawLaunches = (await envioPool.query(`SELECT * FROM ${tables.rawLaunchV2Table} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLaunchV2Row[];
  let launchesWritten = 0;
  const launchByCurve = new Map<string, { launch: Launch; venue: Venue }>();
  for (const raw of rawLaunches) {
    const row: EnvioRawLaunchV2Row = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const event = envioRawLaunchV2ToEvent(row);
    let launch: Launch;
    let venue: Venue;
    try {
      ({ launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory));
    } catch (error) {
      throw new Error(`Failed to sync V2 launch at tx ${raw.txHash} log ${raw.logIndex}: ${(error as Error).message}`, { cause: error });
    }
    launchByCurve.set(event.curveAddress, { launch, venue });
    const inserted = await appDb.transaction(async (tx) => {
      const launchRows = await tx.insert(launchesEnvioStaging).values({
        chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: null, symbol: null,
        tokenDecimals: launch.tokenDecimals, platform: launch.platform, protocolVersion: launch.protocolVersion,
        factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
        launchTxHash: launch.launchTxHash, quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: null,
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

  let tradesWritten = 0;
  const rawTrades = (await envioPool.query(`SELECT * FROM ${tables.rawCurveTradeTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveTradeRow[];
  for (const raw of rawTrades) {
    const context = launchByCurve.get(raw.curveAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawCurveTradeRow = { ...raw, tokenAmountRaw: BigInt(raw.tokenAmountRaw), quoteAmountRaw: BigInt(raw.quoteAmountRaw),
      feeRaw: BigInt(raw.feeRaw), taxRaw: BigInt(raw.taxRaw), blockNumber: BigInt(raw.blockNumber) };
    const trade = hydrateCurveTradeFromDecoded(row, context.venue, context.launch);
    const tradeRows = await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: tradesEnvioStaging.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  const rawBuybacks = (await envioPool.query(`SELECT * FROM ${tables.rawCurveBuybackTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawCurveBuybackRow[];
  for (const raw of rawBuybacks) {
    const context = launchByCurve.get(raw.curveAddress.toLowerCase());
    if (!context) continue;
    const row: EnvioRawCurveBuybackRow = { ...raw, quoteSpentRaw: BigInt(raw.quoteSpentRaw), tokensLockedRaw: BigInt(raw.tokensLockedRaw), blockNumber: BigInt(raw.blockNumber) };
    const trade = hydrateCurveBuybackFromDecoded(row, context.venue, context.launch);
    const tradeRows = await appDb.insert(tradesEnvioStaging).values({
      chainId: trade.chainId, tokenAddress: trade.tokenAddress, venueId: trade.venueId, blockNumber: trade.blockNumber,
      blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex, timestamp: trade.timestamp, side: trade.side,
      tokenAmountRaw: trade.tokenAmountRaw.toString(), quoteAmountRaw: trade.quoteAmountRaw.toString(), activityKind: trade.activityKind,
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: trade.traderAddress,
    }).onConflictDoNothing().returning({ txHash: tradesEnvioStaging.txHash });
    if (tradeRows.length > 0) tradesWritten += 1;
  }

  let transitionsWritten = 0;
  const rawTransitions = (await envioPool.query(`SELECT * FROM ${tables.rawLifecycleTable} ORDER BY "blockNumber", "logIndex"`)).rows as EnvioRawLifecycleRow[];
  for (const raw of rawTransitions) {
    const row: EnvioRawLifecycleRow = { ...raw, blockNumber: BigInt(raw.blockNumber) };
    const transition = envioRawLifecycleToTransition(row, 'pons-v2-lifecycle');
    const rows = await appDb.insert(lifecycleTransitionsEnvioStaging).values({
      sourceLogId: transition.sourceLogId, chainId: transition.chainId, tokenAddress: transition.tokenAddress,
      phase: transition.phase, kind: transition.kind, blockNumber: transition.blockNumber,
      blockHash: transition.blockHash, txHash: transition.txHash, logIndex: transition.logIndex,
    }).onConflictDoNothing().returning({ sourceLogId: lifecycleTransitionsEnvioStaging.sourceLogId });
    if (rows.length > 0) transitionsWritten += 1;
  }

  return { launchesWritten, tradesWritten, transitionsWritten };
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `npm run test:integration -- src/envioSync/runSyncV2.integration.test.ts`
Expected: PASS 1/1.

- [ ] **Step 8: Document the new env vars**

Append to `be/.env.example`:

```
# Envio sync layer — Phase 2 (Pons V2). Same ENVIO_DATABASE_URL as Phase 1.
# ENVIO_RAW_LAUNCH_V2_TABLE=envio."RawLaunchV2"
# ENVIO_RAW_CURVE_TRADE_TABLE=envio."RawCurveTrade"
# ENVIO_RAW_CURVE_BUYBACK_TABLE=envio."RawCurveBuyback"
# ENVIO_RAW_LIFECYCLE_TABLE=envio."RawLifecycleTransition"
```

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts drizzle/ src/envioSync/runSyncV2.ts src/envioSync/runSyncV2.integration.test.ts .env.example
git commit -m "feat: sync Envio raw Pons V2 data into staging tables, idempotently

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Extend the sync and comparison CLIs for V2

**Files:**
- Modify: `be/src/cli/syncEnvioStaging.ts`
- Modify: `be/src/cli/compareEnvioStaging.ts`
- Modify: root `README.md`

**Interfaces:**
- Consumes: `syncV2Once`, `DEFAULT_ENVIO_V2_TABLES` from Task 5.
- Produces: nothing new for later tasks — this is Phase 2's final integration point.

- [ ] **Step 1: Extend the sync CLI to also run V2**

Modify `be/src/cli/syncEnvioStaging.ts` to call both syncs:

```typescript
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { syncV1LegacyOnce, DEFAULT_ENVIO_TABLES } from '../envioSync/runSync.js';
import { syncV2Once, DEFAULT_ENVIO_V2_TABLES } from '../envioSync/runSyncV2.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });

const v1Tables = {
  rawLaunchTable: process.env.ENVIO_RAW_LAUNCH_TABLE ?? DEFAULT_ENVIO_TABLES.rawLaunchTable,
  rawSwapTable: process.env.ENVIO_RAW_SWAP_TABLE ?? DEFAULT_ENVIO_TABLES.rawSwapTable,
};
const v2Tables = {
  rawLaunchV2Table: process.env.ENVIO_RAW_LAUNCH_V2_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLaunchV2Table,
  rawCurveTradeTable: process.env.ENVIO_RAW_CURVE_TRADE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveTradeTable,
  rawCurveBuybackTable: process.env.ENVIO_RAW_CURVE_BUYBACK_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveBuybackTable,
  rawLifecycleTable: process.env.ENVIO_RAW_LIFECYCLE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLifecycleTable,
};

try {
  const v1Result = await syncV1LegacyOnce(envioPool, db, v1Tables);
  console.log('Synced V1-legacy from Envio into staging:', v1Result);
  const v2Result = await syncV2Once(envioPool, db, v2Tables);
  console.log('Synced V2 from Envio into staging:', v2Result);
} finally {
  await pool.end();
  await envioPool.end();
}
```

- [ ] **Step 2: Extend the compare CLI for V2 launches/trades/lifecycle**

Modify `be/src/cli/compareEnvioStaging.ts` — the existing import line is:

```typescript
import { launches, trades, venues, launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
```

Change it to also import `venuesEnvioStaging`, `lifecycleTransitions`, and `lifecycleTransitionsEnvioStaging` (do not add a second import line):

```typescript
import { launches, trades, venues, launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitions, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
```

Then append before the `finally` block:

```typescript
  const realV2Launches = await db.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, 'pons-v2'));
  const stagingV2Launches = await db.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging).where(eq(launchesEnvioStaging.protocolVersion, 'v2'));
  const v2LaunchDiff = compareLaunchCounts(realV2Launches, stagingV2Launches);
  console.log('V2 launches — matching:', v2LaunchDiff.matching, 'only in real:', v2LaunchDiff.onlyInReal.length, 'only in staging:', v2LaunchDiff.onlyInStaging.length);

  const realV2Trades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex })
    .from(trades).innerJoin(venues, eq(trades.venueId, venues.id))
    .where(and(eq(trades.chainId, 4663), eq(venues.sourceId, 'pons-v2')));
  const stagingV2Trades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex })
    .from(tradesEnvioStaging).innerJoin(venuesEnvioStaging, eq(tradesEnvioStaging.venueId, venuesEnvioStaging.id))
    .where(eq(venuesEnvioStaging.kind, 'curve'));
  const v2TradeDiff = compareTradeCounts(realV2Trades, stagingV2Trades);
  console.log('V2 curve trades — matching:', v2TradeDiff.matching, 'only in real:', v2TradeDiff.onlyInReal.length, 'only in staging:', v2TradeDiff.onlyInStaging.length);

  const realTransitions = await db.select({ txHash: lifecycleTransitions.txHash, logIndex: lifecycleTransitions.logIndex }).from(lifecycleTransitions).where(eq(lifecycleTransitions.sourceId, 'pons-v2-lifecycle'));
  const stagingTransitions = await db.select({ txHash: lifecycleTransitionsEnvioStaging.txHash, logIndex: lifecycleTransitionsEnvioStaging.logIndex }).from(lifecycleTransitionsEnvioStaging);
  const transitionDiff = compareTradeCounts(realTransitions, stagingTransitions);
  console.log('Lifecycle transitions — matching:', transitionDiff.matching, 'only in real:', transitionDiff.onlyInReal.length, 'only in staging:', transitionDiff.onlyInStaging.length);
```

`compareTradeCounts` is reused for lifecycle transitions too — it only keys by `(txHash, logIndex)`, which fits any table with those two columns, not just trades; no new comparison function needed (DRY).

- [ ] **Step 3: Typecheck and lint**

```bash
cd be && npx tsc --noEmit && npm run lint
```

Expected: both clean. Fix any import-merge mistakes from Step 2 (the two `from '../db/schema.js'` import lines must become one) before proceeding.

- [ ] **Step 4: Run the full `be` test suite**

Run: `cd be && npm test && TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration`
Expected: all tests pass, including every test added in Tasks 3–5.

- [ ] **Step 5: Update README**

Extend the existing "Envio HyperIndex — thử nghiệm Phase 1" section's heading and content to mention Phase 2 is also covered by the same `sync:envio-staging`/`compare:envio-staging` commands (they now sync/compare both V1-legacy and V2 automatically) — rename the heading to drop "Phase 1" specificity:

```markdown
### Envio HyperIndex — thử nghiệm Phase 1 + Phase 2 (Pons V1-legacy, V2 launch/curve/lifecycle)
```

Add one line after the existing paragraph:

```markdown
`sync:envio-staging`/`compare:envio-staging` giờ đồng bộ và đối chiếu cả V1-legacy lẫn V2
(launch, curve trade, lifecycle transition) trong cùng một lần chạy — xem
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase2.md`.
```

- [ ] **Step 6: Commit**

```bash
cd be && git add src/cli/syncEnvioStaging.ts src/cli/compareEnvioStaging.ts
cd .. && git add README.md
git commit -m "feat: extend the Envio sync/compare CLIs to cover Pons V2

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After this plan

V2 launch, curve trading, and lifecycle transitions now flow through the same Envio pipeline as V1. Per the spec's phased rollout, Phase 3 (V4 pool verification — matching `PoolGraduated` with `PoolManager.Initialize` in the same transaction, then indexing V4 `Swap` events) is next, and needs its own research: Uniswap V4's singleton `PoolManager` contract (one shared address for every pool on the chain, not a per-pool contract like V1's V3 pools or V2's curves) means Phase 1/2's `contractRegister`-per-address pattern does not directly apply — Envio's `where`/wildcard-filtering mechanism (see `envio/.claude/skills/indexer-filters/SKILL.md` and `indexer-wildcard/SKILL.md`, copied in during Phase 1) needs to be evaluated before designing that plan's config.yaml. `be/tests/fixtures/pons-v2-graduated.json`'s `initialize`/`swap` blocks are the cross-check data for that phase, already present in the repo and unused until then.
