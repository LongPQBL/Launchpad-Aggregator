# WebSocket Fast Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Official launch trades reach the database about a second after their block by listening to the chain over WebSocket, while Envio keeps scanning afterwards to add what the lane missed and remove what turned out wrong.

**Architecture:** A new process (`fast-lane:run`) subscribes to the five trade events, keeps the logs whose source is a known launch venue, builds the same raw row Envio writes, and applies it with the existing `applyRow` hydration inside one transaction (`applyLiveRows`). Rows are idempotent on `(chain_id, tx_hash, log_index)`, so Envio's lanes later insert nothing for what the lane already wrote. A 10 s HTTP `getLogs` sweep fills any gap; `incrementalRepair` (with its window bounded by the fence) removes rows Envio does not confirm.

**Tech Stack:** Node 24, TypeScript, viem ^2.56 (WebSocket transport), Drizzle + PostgreSQL, Vitest (unit and `*.integration.test.ts` against `launchpad_test`).

**Spec:** `docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md`. Two points of this plan refine the spec: (1) no `newHeads` subscription — a block header is fetched over HTTP once per block that holds a watched log and cached; (2) gap filling is a periodic sweep (it also covers a reconnect) instead of an on-reconnect hook; and `applyLiveRows` is a new exported function next to `applyRow` rather than a refactor of `applyEnvioPage`. Task 9 updates the spec accordingly.

## Global Constraints

- Work directly on `main`; stage **explicit files only** (the tree has the user's untracked files: `.DS_Store`, `.commandcode/`, `image.png`). End every commit message with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01W8o4GQNKhqRghdJmT9C82m`.
- Backend: Node >=24, TypeScript (`npm run -w be typecheck`), lint `npm run -w be lint`, viem `^2.56.9`.
- Unit tests: `cd be && npx vitest run <file>`. Integration tests (need local Postgres on 55432, DB `launchpad_test`): `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts <file>`.
- `null` means unavailable, never zero: a header or a transaction sender that cannot be had means the log is **skipped**, never filled with a guess.
- The lane is **off by default** (`FAST_LANE_ENABLED=false`). No deployment work. The WebSocket RPC URL is a private key: it lives in `be/.env` / the environment only, never in the repository, a log line or a test.
- Do not change the Envio indexer (`envio/`) or any user-visible copy. Docs for the solo developer may stay Vietnamese (README section in Task 9); code, tests and comments are English.
- Migrations are additive (Task 4 adds two tables).

## Review Focus

Most likely first. Each line is pinned by a test in the named task.

1. A log arrives for a block whose hash differs from the header the node returns now (reorg race) → skipped, no row (Task 5).
2. The same event is delivered by the WebSocket, again by the sweep, and later by Envio → exactly one row and one `trade.created` (Tasks 2, 5).
3. A repair pass runs while the lane has written rows newer than Envio's processed block → those rows survive; a stale row below the fence is still removed (Task 1).
4. `getTransaction` / `getBlock` fails or returns nothing → the log is skipped and counted; no row with a missing or guessed trader (Task 5).
5. The node later reports the log as `removed` (reorg) → the row is deleted and `launch.changed` is announced (Tasks 4, 5).
6. The process restarts after being down for a long time → it resumes from its saved block, and a gap larger than `FAST_LANE_MAX_GAP_BLOCKS` is skipped instead of scanned (Task 5).

---

### Task 1: Bound repair's app-side trade window by the fence

**Files:**
- Modify: `be/src/envioSync/incrementalRepair.ts` (function `appTradeWindow`, its three call sites, the drizzle import)
- Test: `be/src/envioSync/incrementalRepair.integration.test.ts` (new `describe` at the end of the file)

**Interfaces:**
- Produces: `appTradeWindow(tx, chainId, venueKinds, sourceEvents, windowStart, fence)` — only rows with `windowStart <= block_number <= fence` are compared with Envio's keys. Nothing else changes.

- [ ] **Step 1: Write the failing test** — append to `incrementalRepair.integration.test.ts`:

```ts
describe('repairEnvioWindow: rows newer than the fence', () => {
  it('keeps a trade above the fence that Envio has not processed yet, and still removes a stale trade below it', async () => {
    const { token, poolAddress: curveAddress } = freshToken();
    await db.insert(launches).values({
      chainId, tokenAddress: token, sourceId: 'pons-v1-legacy', sourceLogId: legacyRawLogId,
      name: null, symbol: null, tokenDecimals: null, platform: 'pons', protocolVersion: 'v2',
      factoryAddress: curveAddress, deployerAddress: token, launchBlock: 500n, launchBlockHash: `0x${'aa'.repeat(32)}`,
      launchTxHash: `0x${'aa'.repeat(32)}`, launchLogIndex: 1, quoteAssetAddress: weth, quoteAssetSymbol: 'WETH',
      quoteAssetDecimals: 18, lifecycleStatus: 'trading', coreMetadataReadState: 'done',
    });
    await db.insert(venues).values({
      id: `curve-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: curveAddress,
      sourceId: 'pons-v2-curve', sourceLogId: null, effectiveFromBlock: 500n, official: true,
    });
    const trade = (blockNumber: bigint, suffix: string) => ({
      chainId, tokenAddress: token, venueId: `curve-${token}`, blockNumber, blockHash: `0x${suffix.repeat(32)}`,
      txHash: `0x${suffix.repeat(32)}`, logIndex: 1, timestamp: 1_700_000_000, side: 'buy' as const,
      tokenAmountRaw: '1000000000000000000', quoteAmountRaw: '2000000000000000000',
      quoteAssetAddress: weth, sourceEvent: 'CurveBuy', activityKind: 'user_trade',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: token,
    });
    // fence = 1000: block 1200 is newer than anything Envio has processed (a fast-lane row); block 600 is inside the window.
    await db.insert(trades).values([trade(1200n, 'd1'), trade(600n, 'd2')]);
    // Neither has a row in Envio's fixture table.
    await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });

    const remaining = await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    expect(remaining.map((row) => row.blockNumber)).toEqual([1200n]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/envioSync/incrementalRepair`
Expected: the new test FAILS (`remaining` is `[]`: the block-1200 row was deleted as stale).

- [ ] **Step 3: Implement.** In `incrementalRepair.ts` change the import line `import { and, eq, inArray, isNull, gte, sql } from 'drizzle-orm';` to also import `lte`, then change `appTradeWindow`:

```ts
async function appTradeWindow(
  tx: DbOrTx, chainId: number, venueKinds: readonly string[], sourceEvents: readonly string[], windowStart: bigint, fence: bigint,
): Promise<AppKeyedRow[]> {
  const venueIds = tx.select({ id: venues.id }).from(venues).where(inArray(venues.kind, venueKinds));
  // Rows above `fence` are newer than anything Envio has processed (for example rows the WebSocket fast lane wrote): Envio's
  // canonical set cannot confirm or contradict them yet, so repair must not look at them.
  const rows = await tx.select({ txHash: trades.txHash, logIndex: trades.logIndex, blockHash: trades.blockHash, tokenAddress: trades.tokenAddress })
    .from(trades).where(and(
      eq(trades.chainId, chainId), inArray(trades.venueId, venueIds), inArray(trades.sourceEvent, sourceEvents),
      isNull(trades.sourceLogId), gte(trades.blockNumber, windowStart), lte(trades.blockNumber, fence),
    ));
  return rows.map((row) => ({ txHash: row.txHash.toLowerCase(), logIndex: row.logIndex, blockHash: row.blockHash.toLowerCase(), tokenAddress: row.tokenAddress }));
}
```
and pass `input.fence` as the new last argument at the three call sites (`appTradeWindow(tx, input.chainId, ['v3_pool'], ['Swap'], windowStart, input.fence)`, `…['curve'], sourceEvents, windowStart, input.fence)`, `…['v4_pool'], ['Swap'], windowStart, input.fence)`).

- [ ] **Step 4: Run it and see it pass**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/envioSync/incrementalRepair && npx tsc --noEmit`
Expected: all repair tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add be/src/envioSync/incrementalRepair.ts be/src/envioSync/incrementalRepair.integration.test.ts
git commit -m "fix(sync): repair compares trades only up to the fence

Rows above Envio's processed block cannot be confirmed or contradicted yet; a
later fast lane writes such rows and repair must leave them alone."
```
(with the trailer lines from Global Constraints)

---

### Task 2: `applyLiveRows` — apply already-decoded rows with the existing hydration

**Files:**
- Modify: `be/src/envioSync/incrementalSync.ts` (add exports after `applyRow`)
- Test: `be/src/envioSync/incrementalSync.integration.test.ts` (new `describe` after the existing `describe('applyEnvioPage: downstream dependency ordering'…)`)

**Interfaces:**
- Produces:
```ts
export type LiveStream = 'v1-swap' | 'v2-curve' | 'v2-buyback' | 'v4-swap';
export interface LiveEntry { stream: LiveStream; raw: Record<string, unknown> }
export interface ApplyLiveResult { applied: number; unresolved: number; skipped: number; outcomes: readonly ('applied' | 'unresolved' | 'skipped')[] }
export function applyLiveRows(appDb: Database, chainId: number, entries: readonly LiveEntry[]): Promise<ApplyLiveResult>
```
`raw` is the shape Envio's `Raw*` rows have (see `applyV1Swap`, `applyV2Curve`, `applyV2Buyback`, `applyV4Swap`). `outcomes[i]` is for `entries[i]`. One transaction; the volume job is invalidated and `trade.created` announced inside it. An `unresolved` entry is **not** queued (Envio delivers it later).

- [ ] **Step 1: Write the failing test** — in `incrementalSync.integration.test.ts` add `applyLiveRows` to the dynamic import (`const { applyEnvioPage, …, lookupLaunch, applyLiveRows } = await import('./incrementalSync.js');`) and append:

```ts
describe('applyLiveRows', () => {
  async function volumeRevision(token: string): Promise<number | undefined> {
    return (await pool.query('SELECT revision FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows[0]?.revision;
  }
  function liveSwap(poolAddress: string, suffix: string, blockNumber: number) {
    return {
      stream: 'v1-swap' as const,
      raw: {
        id: `live-${suffix}`, chainId, poolAddress, txFrom: '0x1234567890123456789012345678901234567890',
        amount0: '100000000000000000', amount1: '-200000000000000000000', sqrtPriceX96: '2005366647941715384651103712059394',
        blockNumber: String(blockNumber), blockHash: `0x${'ee'.repeat(32)}`, txHash: `0x${createHash('sha256').update(`live-${suffix}`).digest('hex')}`,
        logIndex: 1, timestamp: 1_700_000_000,
      },
    };
  }

  it('inserts the trade like an Envio page would, bumps the volume job and announces trade.created once, even when the same row is applied again', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`live-launch-${token}`, token, poolAddress, txHash, 100, 1);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 500n, limit: 10, tables });
    const before = await volumeRevision(token);

    const entry = liveSwap(poolAddress, token, 110);
    const first = await applyLiveRows(db, chainId, [entry]);
    expect(first).toMatchObject({ applied: 1, unresolved: 0, outcomes: ['applied'] });
    const rows = await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: entry.raw.txHash, logIndex: 1, sourceEvent: 'Swap' });
    expect(await volumeRevision(token)).toBe((before ?? 0) + 1);
    const announced = vi.mocked(notifyChanged).mock.calls.at(-1)![1];
    expect(announced).toEqual([expect.objectContaining({ kind: 'trade.created', chainId, tokenAddress: token })]);

    await applyLiveRows(db, chainId, [entry]);
    expect(await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)))).toHaveLength(1);
    expect(vi.mocked(notifyChanged).mock.calls.at(-1)![1]).toEqual([]); // nothing new: nothing announced
  });

  it('reports a row whose venue is unknown as unresolved, without inserting it or queueing it', async () => {
    const queuedBefore = await db.select().from(unresolvedEvents).where(eq(unresolvedEvents.chainId, chainId));
    const result = await applyLiveRows(db, chainId, [liveSwap('0x20ffff000000000000000000000000000000ffff', 'unknown-pool', 120)]);
    expect(result).toMatchObject({ applied: 0, unresolved: 1, outcomes: ['unresolved'] });
    expect(await db.select().from(unresolvedEvents).where(eq(unresolvedEvents.chainId, chainId))).toHaveLength(queuedBefore.length);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/envioSync/incrementalSync`
Expected: FAIL — `applyLiveRows is not a function`.

- [ ] **Step 3: Implement** — in `incrementalSync.ts`, after the `applyRow` function:

```ts
export type LiveStream = 'v1-swap' | 'v2-curve' | 'v2-buyback' | 'v4-swap';
export interface LiveEntry { stream: LiveStream; raw: Record<string, unknown> }
export interface ApplyLiveResult { applied: number; unresolved: number; skipped: number; outcomes: readonly ApplyOutcome[] }

/**
 * Applies raw rows that did not come from an Envio page (the WebSocket fast lane builds them in Envio's own raw shape) with exactly
 * the hydration `applyEnvioPage` uses. One transaction: rows in the given order, then the launch volume jobs are invalidated and
 * `trade.created` is announced, so delivery happens after commit. A row whose launch or venue is not in the database yet is only
 * reported `unresolved` — not queued, since Envio delivers every event itself.
 */
export async function applyLiveRows(appDb: Database, chainId: number, entries: readonly LiveEntry[]): Promise<ApplyLiveResult> {
  const changes: ChangeNotification[] = [];
  const newQuoteAssets: QuoteAssetToEnqueue[] = [];
  const outcomes: ApplyOutcome[] = [];
  await appDb.transaction(async (tx) => {
    for (const entry of entries) outcomes.push(await applyRow(tx, chainId, entry.stream, entry.raw, newQuoteAssets, changes));
    await invalidateLaunchVolume(tx, launchKeysFromChanges(changes), new Date());
    await notifyChanged(tx, changes);
  });
  const count = (outcome: ApplyOutcome) => outcomes.filter((value) => value === outcome).length;
  return { applied: count('applied'), unresolved: count('unresolved'), skipped: count('skipped'), outcomes };
}
```
(`ApplyOutcome` is the file's existing non-exported type; it is used only in the exported signature as a string union, which TypeScript allows. If lint complains, export it.)

- [ ] **Step 4: Run it and see it pass**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/envioSync/incrementalSync && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add be/src/envioSync/incrementalSync.ts be/src/envioSync/incrementalSync.integration.test.ts
git commit -m "feat(sync): applyLiveRows applies decoded raw rows with the existing hydration"
```

---

### Task 3: Log classification and decoding into Envio's raw shape

**Files:**
- Create: `be/src/fastLane/decode.ts`
- Test: `be/src/fastLane/decode.test.ts`

**Interfaces:**
- Consumes: `LiveStream`, `LiveEntry` from Task 2; ABI items `curveBuyEvent`, `curveSellEvent`, `curveBuybackEvent` (`launchpads/pons/v2/abi.ts`), `v3SwapEvent` (`launchpads/pons/v1/abi.ts`), `v4SwapEvent` (`launchpads/pons/v2/v4Swaps.ts`).
- Produces:
```ts
export interface FastLog { address: string; topics: readonly string[]; data: string; blockNumber: bigint; blockHash: string; transactionHash: string; logIndex: number; removed?: boolean }
export type WatchKind = 'curve' | 'v3_pool' | 'v4_pool';
export interface LogClass { event: 'CurveBuy' | 'CurveSell' | 'BuybackLocked' | 'V3Swap' | 'V4Swap'; stream: LiveStream; watchKind: WatchKind; watchRef: string }
export const FAST_LANE_EVENTS: readonly [typeof curveBuyEvent, typeof curveSellEvent, typeof curveBuybackEvent, typeof v3SwapEvent, typeof v4SwapEvent]
export function classifyLog(log: Pick<FastLog, 'address' | 'topics'>): LogClass | null     // topics only, no decoding
export function decodeLiveLog(log: FastLog, context: { chainId: number; timestamp: number; txFrom: string }): LiveEntry | null
```
The raw rows have exactly the fields of `envio/src/EventHandlers.ts` for the same event; numbers are decimal **strings** (so they survive JSON in `fast_lane_rows`), `id` is `${chainId}-${blockHash}-${txHash}-${logIndex}`.

- [ ] **Step 1: Write the failing test** — `be/src/fastLane/decode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent } from '../launchpads/pons/v2/abi.js';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import { classifyLog, decodeLiveLog, FAST_LANE_EVENTS, type FastLog } from './decode.js';

const curve = '0xAbCdEf0000000000000000000000000000000001';
const trader = '0x1111111111111111111111111111111111111111';
const blockHash = `0x${'b1'.repeat(32)}`;
const txHash = `0x${'a1'.repeat(32)}`;
const poolId = `0x${'cd'.repeat(32)}`;
const context = { chainId: 4663, timestamp: 1_700_000_123, txFrom: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa' };

function log(address: string, topics: readonly string[], data: string, logIndex = 7): FastLog {
  return { address, topics, data, blockNumber: 1234n, blockHash, transactionHash: txHash, logIndex };
}
const uint = (n: bigint) => ({ type: 'uint256' as const, value: n });
function curveBuyLog() {
  const topics = encodeEventTopics({ abi: [curveBuyEvent], eventName: 'CurveBuy', args: { buyer: trader, recipient: trader } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [2000n, 1000n, 20n, 5n]);
  return log(curve, topics, data);
}
function curveSellLog() {
  const topics = encodeEventTopics({ abi: [curveSellEvent], eventName: 'CurveSell', args: { seller: trader, recipient: trader } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1000n, 1900n, 19n, 4n]);
  return log(curve, topics, data);
}
function buybackLog() {
  const topics = encodeEventTopics({ abi: [curveBuybackEvent], eventName: 'BuybackLocked' });
  return log(curve, topics, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [700n, 500n]));
}
function v3Log() {
  const topics = encodeEventTopics({ abi: [v3SwapEvent], eventName: 'Swap', args: { sender: trader, recipient: trader } });
  const data = encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [100n, -200n, 79228162514264337593543950336n, 5n, -12]);
  return log('0x2000000000000000000000000000000000000AbC', topics, data);
}
function v4Log() {
  const topics = encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: poolId, sender: trader } });
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [-300n, 600n, 79228162514264337593543950336n, 9n, 4, 3000]);
  return log('0x8366a39cC670b4001a1121b8f6A443A643E40951', topics, data);
}

describe('classifyLog', () => {
  it('names the stream and the venue a log must belong to, from its topics only', () => {
    expect(classifyLog(curveBuyLog())).toEqual({ event: 'CurveBuy', stream: 'v2-curve', watchKind: 'curve', watchRef: curve.toLowerCase() });
    expect(classifyLog(curveSellLog())).toMatchObject({ event: 'CurveSell', stream: 'v2-curve', watchKind: 'curve' });
    expect(classifyLog(buybackLog())).toMatchObject({ event: 'BuybackLocked', stream: 'v2-buyback', watchKind: 'curve' });
    expect(classifyLog(v3Log())).toEqual({ event: 'V3Swap', stream: 'v1-swap', watchKind: 'v3_pool', watchRef: '0x2000000000000000000000000000000000000abc' });
    expect(classifyLog(v4Log())).toEqual({ event: 'V4Swap', stream: 'v4-swap', watchKind: 'v4_pool', watchRef: poolId });
  });
  it('ignores a log of any other event, and a V4 swap without its pool id topic', () => {
    expect(classifyLog({ address: curve, topics: [`0x${'00'.repeat(32)}`] })).toBeNull();
    expect(classifyLog({ address: curve, topics: [] })).toBeNull();
    expect(classifyLog({ address: curve, topics: [v4Log().topics[0]!] })).toBeNull();
  });
  it('subscribes to exactly the five events', () => {
    expect(FAST_LANE_EVENTS).toHaveLength(5);
  });
});

describe('decodeLiveLog builds the raw row Envio writes for the same event', () => {
  const id = `4663-${blockHash}-${txHash}-7`;
  const position = { txFrom: context.txFrom.toLowerCase(), blockNumber: '1234', blockHash, txHash, logIndex: 7, timestamp: 1_700_000_123 };

  it('CurveBuy: tokens out and quote in, with fee and tax', () => {
    expect(decodeLiveLog(curveBuyLog(), context)).toEqual({ stream: 'v2-curve', raw: {
      id, chainId: 4663, curveAddress: curve.toLowerCase(), side: 'buy', tokenAmountRaw: '1000', quoteAmountRaw: '2000', feeRaw: '20', taxRaw: '5', ...position } });
  });
  it('CurveSell: tokens in and quote out', () => {
    expect(decodeLiveLog(curveSellLog(), context)).toEqual({ stream: 'v2-curve', raw: {
      id, chainId: 4663, curveAddress: curve.toLowerCase(), side: 'sell', tokenAmountRaw: '1000', quoteAmountRaw: '1900', feeRaw: '19', taxRaw: '4', ...position } });
  });
  it('BuybackLocked', () => {
    expect(decodeLiveLog(buybackLog(), context)).toEqual({ stream: 'v2-buyback', raw: {
      id, chainId: 4663, curveAddress: curve.toLowerCase(), quoteSpentRaw: '700', tokensLockedRaw: '500', ...position } });
  });
  it('V3 swap', () => {
    expect(decodeLiveLog(v3Log(), context)).toEqual({ stream: 'v1-swap', raw: {
      id, chainId: 4663, poolAddress: '0x2000000000000000000000000000000000000abc', amount0: '100', amount1: '-200',
      sqrtPriceX96: '79228162514264337593543950336', ...position } });
  });
  it('V4 swap: pool id and sender, liquidity and tick left at their unused placeholders, fee as a number', () => {
    expect(decodeLiveLog(v4Log(), context)).toEqual({ stream: 'v4-swap', raw: {
      id, chainId: 4663, poolId, sender: trader, amount0: '-300', amount1: '600', sqrtPriceX96: '79228162514264337593543950336',
      liquidity: '0', tick: 0, fee: 3000, ...position } });
  });
  it('returns null for malformed data or an unknown event instead of throwing', () => {
    expect(decodeLiveLog({ ...curveBuyLog(), data: '0x1234' }, context)).toBeNull();
    expect(decodeLiveLog({ ...curveBuyLog(), topics: [`0x${'00'.repeat(32)}`] }, context)).toBeNull();
  });
});
```
(Remove the unused `uint` helper if lint flags it.)

- [ ] **Step 2: Run it and see it fail**

Run: `cd be && npx vitest run src/fastLane/decode.test.ts`
Expected: FAIL — cannot find module `./decode.js`.

- [ ] **Step 3: Implement `be/src/fastLane/decode.ts`:**

```ts
import { decodeEventLog, toEventSelector, type Hex } from 'viem';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent } from '../launchpads/pons/v2/abi.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import type { LiveEntry, LiveStream } from '../envioSync/incrementalSync.js';

export interface FastLog {
  address: string; topics: readonly string[]; data: string;
  blockNumber: bigint; blockHash: string; transactionHash: string; logIndex: number; removed?: boolean;
}
export type WatchKind = 'curve' | 'v3_pool' | 'v4_pool';
export type LiveEventName = 'CurveBuy' | 'CurveSell' | 'BuybackLocked' | 'V3Swap' | 'V4Swap';
export interface LogClass { event: LiveEventName; stream: LiveStream; watchKind: WatchKind; watchRef: string }

/** Every event the lane listens to. The order is not significant. */
export const FAST_LANE_EVENTS = [curveBuyEvent, curveSellEvent, curveBuybackEvent, v3SwapEvent, v4SwapEvent] as const;

const EVENT_BY_SELECTOR = new Map<string, LiveEventName>([
  [toEventSelector(curveBuyEvent), 'CurveBuy'], [toEventSelector(curveSellEvent), 'CurveSell'], [toEventSelector(curveBuybackEvent), 'BuybackLocked'],
  [toEventSelector(v3SwapEvent), 'V3Swap'], [toEventSelector(v4SwapEvent), 'V4Swap'],
]);

/** What a log is and which known venue it would have to belong to — from its topics alone, so a cheap filter can run before any RPC call. */
export function classifyLog(log: Pick<FastLog, 'address' | 'topics'>): LogClass | null {
  const event = EVENT_BY_SELECTOR.get(log.topics[0]?.toLowerCase() ?? '');
  if (!event) return null;
  const address = log.address.toLowerCase();
  switch (event) {
    case 'CurveBuy': case 'CurveSell': return { event, stream: 'v2-curve', watchKind: 'curve', watchRef: address };
    case 'BuybackLocked': return { event, stream: 'v2-buyback', watchKind: 'curve', watchRef: address };
    case 'V3Swap': return { event, stream: 'v1-swap', watchKind: 'v3_pool', watchRef: address };
    case 'V4Swap': {
      const poolId = log.topics[1];
      return poolId ? { event, stream: 'v4-swap', watchKind: 'v4_pool', watchRef: poolId.toLowerCase() } : null;
    }
  }
}

/**
 * Builds the raw row `envio/src/EventHandlers.ts` writes for the same event, so `applyLiveRows` hydrates it exactly like an Envio row.
 * Amounts are decimal strings. Returns null (never throws) for an unknown event or data that does not decode.
 */
export function decodeLiveLog(log: FastLog, context: { chainId: number; timestamp: number; txFrom: string }): LiveEntry | null {
  const cls = classifyLog(log);
  if (!cls) return null;
  const topics = log.topics as [Hex, ...Hex[]];
  const data = log.data as Hex;
  const position = {
    id: `${context.chainId}-${log.blockHash}-${log.transactionHash}-${log.logIndex}`, chainId: context.chainId,
  };
  const where = {
    txFrom: context.txFrom.toLowerCase(), blockNumber: log.blockNumber.toString(), blockHash: log.blockHash,
    txHash: log.transactionHash, logIndex: log.logIndex, timestamp: context.timestamp,
  };
  const s = (value: bigint | number) => value.toString();
  try {
    switch (cls.event) {
      case 'CurveBuy': {
        const { args } = decodeEventLog({ abi: [curveBuyEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, curveAddress: cls.watchRef, side: 'buy', tokenAmountRaw: s(args.tokensOut),
          quoteAmountRaw: s(args.quoteIn), feeRaw: s(args.fee), taxRaw: s(args.tax), ...where } };
      }
      case 'CurveSell': {
        const { args } = decodeEventLog({ abi: [curveSellEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, curveAddress: cls.watchRef, side: 'sell', tokenAmountRaw: s(args.tokensIn),
          quoteAmountRaw: s(args.quoteOut), feeRaw: s(args.fee), taxRaw: s(args.tax), ...where } };
      }
      case 'BuybackLocked': {
        const { args } = decodeEventLog({ abi: [curveBuybackEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, curveAddress: cls.watchRef, quoteSpentRaw: s(args.quoteSpent),
          tokensLockedRaw: s(args.tokensLocked), ...where } };
      }
      case 'V3Swap': {
        const { args } = decodeEventLog({ abi: [v3SwapEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, poolAddress: cls.watchRef, amount0: s(args.amount0), amount1: s(args.amount1),
          sqrtPriceX96: s(args.sqrtPriceX96), ...where } };
      }
      case 'V4Swap': {
        const { args } = decodeEventLog({ abi: [v4SwapEvent], data, topics, strict: true });
        // liquidity and tick are stored by Envio as unused placeholders (see its V4Swap handler); fee is a number there.
        return { stream: cls.stream, raw: { ...position, poolId: cls.watchRef, sender: args.sender.toLowerCase(), amount0: s(args.amount0),
          amount1: s(args.amount1), sqrtPriceX96: s(args.sqrtPriceX96), liquidity: '0', tick: 0, fee: Number(args.fee), ...where } };
      }
    }
  } catch {
    return null;
  }
}
```
Key order in the test's `toEqual` does not matter.

- [ ] **Step 4: Run it and see it pass**

Run: `cd be && npx vitest run src/fastLane/decode.test.ts && npx tsc --noEmit && npx eslint src/fastLane`
Expected: PASS, clean. (If `tsc` objects to `strict: true` argument typing for the topics tuple, keep the cast shown above.)

- [ ] **Step 5: Commit**

```bash
git add be/src/fastLane/decode.ts be/src/fastLane/decode.test.ts
git commit -m "feat(fast-lane): classify trade logs and decode them into Envio's raw row shape"
```

---

### Task 4: Tables, watch set and lane store

**Files:**
- Modify: `be/src/db/schema.ts` (two tables), generated: `be/drizzle/0055_*.sql`, `be/drizzle/meta/*`
- Create: `be/src/fastLane/watchSet.ts`, `be/src/fastLane/store.ts`
- Test: `be/src/fastLane/watchSet.integration.test.ts`, `be/src/fastLane/store.integration.test.ts`

**Interfaces:**
- Consumes: `LogClass`, `WatchKind` (Task 3); `LiveEntry` (Task 2); `invalidateLaunchVolume`, `notifyChanged`.
- Produces:
```ts
// watchSet.ts
export interface WatchSet { curve: ReadonlySet<string>; v3_pool: ReadonlySet<string>; v4_pool: ReadonlySet<string> }
export const EMPTY_WATCH_SET: WatchSet
export function loadWatchSet(pool: Pool, chainId: number): Promise<WatchSet>        // venues of kind curve / v3_pool / v4_pool, refs lower-cased
export function isWatched(set: WatchSet, cls: Pick<LogClass, 'watchKind' | 'watchRef'>): boolean
// store.ts
export function recordFastRows(db: Database, chainId: number, entries: readonly LiveEntry[]): Promise<void>
export function readLaneBlock(db: Database, chainId: number): Promise<bigint | null>
export function advanceLaneBlock(db: Database, chainId: number, block: bigint): Promise<void>   // never moves backwards
export function removeLaneTrade(db: Database, chainId: number, key: { txHash: string; logIndex: number; blockHash: string }): Promise<boolean>
```

- [ ] **Step 1: Add the tables** to `be/src/db/schema.ts` (after `envioChainProgress`):

```ts
// The rows the WebSocket fast lane (be/src/fastLane) wrote into `trades`, kept until `fast-lane:parity` has compared them with what Envio
// produced for the same event. `raw` is the exact raw row the lane fed to applyLiveRows.
export const fastLaneRows = pgTable('fast_lane_rows', {
  chainId: integer('chain_id').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  stream: text('stream').notNull(),
  raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  writtenAt: timestamp('written_at').notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
  index('fast_lane_rows_written_idx').on(table.writtenAt),
]);

// The highest block the fast lane has fully handled, per chain: where a restart resumes.
export const fastLaneState = pgTable('fast_lane_state', {
  chainId: integer('chain_id').primaryKey(),
  lastBlock: bigint('last_block', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```
Generate the migration: `cd be && npx drizzle-kit generate --name fast_lane` (creates `drizzle/0055_fast_lane.sql` plus the snapshot and journal entry). Open the SQL and check it only contains the two `CREATE TABLE`s and the index.

- [ ] **Step 2: Write the failing tests.**

`be/src/fastLane/watchSet.integration.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { isWatched, loadWatchSet } from './watchSet.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const chainId = 4663;
const source = 'fast-lane-watch-test';
const token = '0x7a00000000000000000000000000000000000001';
const refs = { curve: '0x7a000000000000000000000000000000000000c1', v3: '0x7a000000000000000000000000000000000000a3', v4: `0x${'7a'.repeat(32)}` };

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol,
    quote_asset_decimals, lifecycle_status) VALUES ($1,$2,$3,'W','W',18,'pons','v2',$2,$2,1,$4,0,$2,'WETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'7a'.repeat(32)}`]);
  for (const [kind, ref] of [['curve', refs.curve.toUpperCase().replace('0X', '0x')], ['v3_pool', refs.v3], ['v4_pool', refs.v4]] as const) {
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1,$2,$3,$4,$5,$6,1,true) ON CONFLICT DO NOTHING`, [`watch-${kind}`, chainId, token, kind, ref, source]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('loadWatchSet', () => {
  it('lists the curve, V3 pool and V4 pool venues of the chain, lower-cased', async () => {
    const set = await loadWatchSet(pool, chainId);
    expect(set.curve.has(refs.curve)).toBe(true);
    expect(set.v3_pool.has(refs.v3)).toBe(true);
    expect(set.v4_pool.has(refs.v4)).toBe(true);
    expect(isWatched(set, { watchKind: 'curve', watchRef: refs.curve })).toBe(true);
    expect(isWatched(set, { watchKind: 'curve', watchRef: refs.v3 })).toBe(false); // right address, wrong kind
    expect(isWatched(set, { watchKind: 'v4_pool', watchRef: `0x${'00'.repeat(32)}` })).toBe(false);
  });
  it('does not list another chain', async () => {
    const set = await loadWatchSet(pool, 1);
    expect(set.curve.has(refs.curve)).toBe(false);
  });
});
```

`be/src/fastLane/store.integration.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, fastLaneState, trades } from '../db/schema.js';
import { advanceLaneBlock, readLaneBlock, recordFastRows, removeLaneTrade } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const chainId = 996641; // a private chain id: no other test touches it
const source = 'fast-lane-store-test';
const token = '0x7b00000000000000000000000000000000000001';
const txHash = `0x${'7b'.repeat(32)}`;
const blockHash = `0x${'7c'.repeat(32)}`;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol,
    quote_asset_decimals, lifecycle_status) VALUES ($1,$2,$3,'S','S',18,'pons','v2',$2,$2,1,$4,0,$2,'WETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'7b'.repeat(32)}`]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ('store-venue', $1, $2, 'curve', $2, $3, 1, true) ON CONFLICT DO NOTHING`, [chainId, token, source]);
});
afterAll(async () => {
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  await db.delete(trades).where(eq(trades.chainId, chainId));
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('lane state', () => {
  it('starts empty, stores the highest block and never moves backwards', async () => {
    expect(await readLaneBlock(db, chainId)).toBeNull();
    await advanceLaneBlock(db, chainId, 500n);
    await advanceLaneBlock(db, chainId, 400n);
    expect(await readLaneBlock(db, chainId)).toBe(500n);
    await advanceLaneBlock(db, chainId, 501n);
    expect(await readLaneBlock(db, chainId)).toBe(501n);
  });
});

describe('recordFastRows', () => {
  it('keeps the raw row by (chain, tx hash, log index) and ignores a repeat', async () => {
    const entry = { stream: 'v2-curve' as const, raw: { id: 'x', txHash, logIndex: 3, blockNumber: '900', curveAddress: token } };
    await recordFastRows(db, chainId, [entry, entry]);
    const rows = await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash, logIndex: 3, stream: 'v2-curve', blockNumber: 900n });
    expect(rows[0]!.raw).toMatchObject({ curveAddress: token });
  });
});

describe('removeLaneTrade', () => {
  async function insertTrade(hash: string): Promise<void> {
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: 'store-venue', blockNumber: 901n, blockHash, txHash: hash, logIndex: 4, timestamp: 1_700_000_000,
      side: 'buy', tokenAmountRaw: '1', quoteAmountRaw: '2', quoteAssetAddress: token, sourceEvent: 'CurveBuy', activityKind: 'user_trade',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: token,
    });
  }
  it('deletes the trade only when the block hash matches, drops its bookkeeping and bumps the launch volume job', async () => {
    const hash = `0x${'7d'.repeat(32)}`;
    await insertTrade(hash);
    await recordFastRows(db, chainId, [{ stream: 'v2-curve', raw: { txHash: hash, logIndex: 4, blockNumber: '901' } }]);
    expect(await removeLaneTrade(db, chainId, { txHash: hash, logIndex: 4, blockHash: `0x${'00'.repeat(32)}` })).toBe(false); // a different block: not ours to remove
    expect(await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, hash)))).toHaveLength(1);
    expect(await removeLaneTrade(db, chainId, { txHash: hash.toUpperCase().replace('0X', '0x'), logIndex: 4, blockHash: blockHash.toUpperCase().replace('0X', '0x') })).toBe(true);
    expect(await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, hash)))).toHaveLength(0);
    expect(await db.select().from(fastLaneRows).where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, hash)))).toHaveLength(0);
    const job = await pool.query('SELECT revision FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    expect(job.rows[0]?.revision).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/fastLane`
Expected: FAIL — cannot find `./watchSet.js` / `./store.js`.

- [ ] **Step 4: Implement.**

`be/src/fastLane/watchSet.ts`:
```ts
import type { Pool } from 'pg';
import type { LogClass, WatchKind } from './decode.js';

export type WatchSet = Readonly<Record<WatchKind, ReadonlySet<string>>>;
export const EMPTY_WATCH_SET: WatchSet = { curve: new Set(), v3_pool: new Set(), v4_pool: new Set() };

/** The venues a trade log can belong to: bonding curves, V3 pools and V4 pool ids that launches already have in the database. */
export async function loadWatchSet(pool: Pool, chainId: number): Promise<WatchSet> {
  const result = await pool.query(`SELECT kind, ref FROM venues WHERE chain_id = $1 AND kind IN ('curve', 'v3_pool', 'v4_pool')`, [chainId]);
  const sets: Record<WatchKind, Set<string>> = { curve: new Set(), v3_pool: new Set(), v4_pool: new Set() };
  for (const row of result.rows as { kind: WatchKind; ref: string }[]) sets[row.kind].add(row.ref.toLowerCase());
  return sets;
}

export function isWatched(set: WatchSet, cls: Pick<LogClass, 'watchKind' | 'watchRef'>): boolean {
  return set[cls.watchKind].has(cls.watchRef);
}
```

`be/src/fastLane/store.ts`:
```ts
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fastLaneRows, fastLaneState, trades } from '../db/schema.js';
import type { LiveEntry } from '../envioSync/incrementalSync.js';
import { notifyChanged } from '../envioSync/notifyChanges.js';
import { invalidateLaunchVolume } from '../market/launchVolume/store.js';

/** Remembers which rows the lane wrote, with the raw row it fed in, until the parity command has compared them with Envio's. */
export async function recordFastRows(db: Database, chainId: number, entries: readonly LiveEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(fastLaneRows).values(entries.map((entry) => ({
    chainId, txHash: String(entry.raw.txHash).toLowerCase(), logIndex: Number(entry.raw.logIndex), stream: entry.stream,
    raw: entry.raw, blockNumber: BigInt(String(entry.raw.blockNumber)),
  }))).onConflictDoNothing();
}

export async function readLaneBlock(db: Database, chainId: number): Promise<bigint | null> {
  const [row] = await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  return row?.lastBlock ?? null;
}

export async function advanceLaneBlock(db: Database, chainId: number, block: bigint): Promise<void> {
  await db.insert(fastLaneState).values({ chainId, lastBlock: block }).onConflictDoUpdate({
    target: fastLaneState.chainId,
    set: { lastBlock: sql`GREATEST(${fastLaneState.lastBlock}, excluded.last_block)`, updatedAt: new Date() },
  });
}

/**
 * The node reported a log as removed (its block was reorganised away): delete the trade written for exactly that block, forget its
 * bookkeeping, and tell the launch's pages. A row for the same event under a different block hash is a replacement and is left alone.
 */
export async function removeLaneTrade(db: Database, chainId: number, key: { txHash: string; logIndex: number; blockHash: string }): Promise<boolean> {
  const txHash = key.txHash.toLowerCase();
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(trades).where(and(
      eq(trades.chainId, chainId), eq(trades.txHash, txHash), eq(trades.logIndex, key.logIndex),
      sql`lower(${trades.blockHash}) = ${key.blockHash.toLowerCase()}`,
    )).returning({ tokenAddress: trades.tokenAddress });
    if (deleted.length === 0) return false;
    await tx.delete(fastLaneRows).where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, txHash), eq(fastLaneRows.logIndex, key.logIndex)));
    const launchKeys = [...new Set(deleted.map((row) => row.tokenAddress))].map((tokenAddress) => ({ chainId, tokenAddress }));
    await invalidateLaunchVolume(tx, launchKeys, new Date());
    await notifyChanged(tx, launchKeys.map((launch) => ({ kind: 'launch.changed' as const, chainId, tokenAddress: launch.tokenAddress })));
    return true;
  });
}
```

- [ ] **Step 5: Run them and see them pass**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/fastLane && npx tsc --noEmit && npx eslint src`
Expected: PASS (the integration config runs migrations first, so `0055` is applied to `launchpad_test`).

- [ ] **Step 6: Commit**

```bash
git add be/src/db/schema.ts be/drizzle be/src/fastLane/watchSet.ts be/src/fastLane/store.ts be/src/fastLane/watchSet.integration.test.ts be/src/fastLane/store.integration.test.ts
git commit -m "feat(fast-lane): watch set, row bookkeeping and lane state tables"
```
(Check `git status` first: stage only the new `drizzle/0055_*.sql`, the new snapshot under `drizzle/meta/` and the modified `drizzle/meta/_journal.json`.)

---

### Task 5: The lane runner (pipeline, sweep, removals)

**Files:**
- Create: `be/src/fastLane/runner.ts`
- Test: `be/src/fastLane/runner.integration.test.ts`

**Interfaces:**
- Consumes: `FastLog`, `classifyLog`, `decodeLiveLog` (Task 3); `applyLiveRows`, `LiveEntry` (Task 2); `loadWatchSet`, `isWatched`, `EMPTY_WATCH_SET`, `WatchSet` (Task 4); `recordFastRows`, `readLaneBlock`, `advanceLaneBlock`, `removeLaneTrade` (Task 4).
- Produces:
```ts
export interface BlockHeader { number: bigint; hash: string; timestamp: number }
export interface LaneChainSource {
  getBlock(blockNumber: bigint): Promise<BlockHeader | null>;
  getTransactionSender(txHash: string): Promise<string | null>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<FastLog[]>;
  getBlockNumber(): Promise<bigint>;
  subscribeLogs(onLogs: (logs: FastLog[]) => void, onError: (error: Error) => void): () => void;   // returns unsubscribe
}
export interface FastLaneOptions {
  chainId: number; sweepEveryMs?: number /*10000*/; watchRefreshEveryMs?: number /*10000*/; sweepLagBlocks?: bigint /*2n*/;
  maxGapBlocks?: bigint /*20000n*/; sweepChunkBlocks?: bigint /*2000n*/; lookupRetries?: number /*3*/; lookupRetryDelayMs?: number /*100*/;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface FastLaneStats { received: number; watched: number; applied: number; unresolved: number; skipped: number; removed: number; errors: number; sweeps: number }
export interface FastLane {
  start(): Promise<void>; stop(): Promise<void>;
  handleLogs(logs: readonly FastLog[]): Promise<void>;     // the WebSocket path; serialised with everything else
  sweepOnce(): Promise<void>;
  reloadWatchSet(): Promise<void>;
  stats(): FastLaneStats;
}
export function createFastLane(deps: { source: LaneChainSource; db: Database; pool: Pool }, options: FastLaneOptions): FastLane
```

- [ ] **Step 1: Write the failing test** — `be/src/fastLane/runner.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { and, eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, fastLaneState, launches, trades, venues } from '../db/schema.js';
import { curveBuyEvent } from '../launchpads/pons/v2/abi.js';
import type { FastLog } from './decode.js';
import { createFastLane, type BlockHeader, type LaneChainSource } from './runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const chainId = 4663; // applyRow hydrates against the Pons sources, which are chain 4663
const source = 'fast-lane-runner-test';
const token = '0x7e00000000000000000000000000000000000001';
const curve = '0x7e000000000000000000000000000000000000c1';
const unwatchedCurve = '0x7e000000000000000000000000000000000000c2';
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const trader = '0x1111111111111111111111111111111111111111';
const blockHash = `0x${'b7'.repeat(32)}`;
let nextTx = 0;

function buyLog(overrides: Partial<FastLog> = {}, address = curve): FastLog {
  nextTx += 1;
  const topics = encodeEventTopics({ abi: [curveBuyEvent], eventName: 'CurveBuy', args: { buyer: trader, recipient: trader } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [2000000000000000000n, 1000000000000000000n, 0n, 0n]);
  return { address, topics, data, blockNumber: 5000n, blockHash, transactionHash: `0x${nextTx.toString(16).padStart(64, '0')}`, logIndex: 2, ...overrides };
}

interface Fake extends LaneChainSource { calls: { getBlock: number; getTransactionSender: number }; logs: FastLog[]; head: bigint; header: BlockHeader | null; sender: string | null }
function fakeSource(): Fake {
  const fake: Fake = {
    calls: { getBlock: 0, getTransactionSender: 0 }, logs: [], head: 5100n, header: { number: 5000n, hash: blockHash, timestamp: 1_700_000_000 }, sender: trader,
    async getBlock() { fake.calls.getBlock += 1; return fake.header; },
    async getTransactionSender() { fake.calls.getTransactionSender += 1; return fake.sender; },
    async getLogs(from, to) { return fake.logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to); },
    async getBlockNumber() { return fake.head; },
    subscribeLogs() { return () => {}; },
  };
  return fake;
}

const listener = new Client({ connectionString: databaseUrl });
const notifications: Record<string, unknown>[] = [];
beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await db.insert(launches).values({
    chainId, tokenAddress: token, sourceId: source, sourceLogId: null, name: 'Lane', symbol: 'LANE', tokenDecimals: 18, platform: 'pons',
    protocolVersion: 'v2', factoryAddress: curve, deployerAddress: token, launchBlock: 100n, launchBlockHash: `0x${'aa'.repeat(32)}`,
    launchTxHash: `0x${'7e'.repeat(32)}`, launchLogIndex: 1, quoteAssetAddress: weth, quoteAssetSymbol: 'WETH', quoteAssetDecimals: 18,
    lifecycleStatus: 'trading', coreMetadataReadState: 'done',
  }).onConflictDoNothing();
  await db.insert(venues).values({
    id: `fast-lane-curve-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: curve, sourceId: source, sourceLogId: null,
    effectiveFromBlock: 100n, official: true,
  }).onConflictDoNothing();
  await listener.connect();
  listener.on('notification', (message) => { if (message.payload) notifications.push(JSON.parse(message.payload)); });
  await listener.query('LISTEN launchpad_events');
});
beforeEach(async () => {
  notifications.length = 0;
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
});
afterAll(async () => {
  await listener.query('UNLISTEN launchpad_events');
  await listener.end();
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

async function lane(fake: Fake, extra: Record<string, unknown> = {}) {
  const instance = createFastLane({ source: fake, db, pool }, { chainId, lookupRetryDelayMs: 1, ...extra });
  await instance.reloadWatchSet();
  return instance;
}
const tradeRows = () => db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('fast lane', () => {
  it('writes a watched trade with the real trader and block time, records it, advances its block and announces trade.created', async () => {
    const fake = fakeSource();
    const log = buyLog();
    await (await lane(fake)).handleLogs([log]);
    await settle();
    const rows = await tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: log.transactionHash, logIndex: 2, side: 'buy', sourceEvent: 'CurveBuy', timestamp: 1_700_000_000, traderAddress: trader });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(1);
    expect((await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId)))[0]?.lastBlock).toBe(5000n);
    expect(notifications).toContainEqual(expect.objectContaining({ type: 'trade.created', chainId, tokenAddress: token, blockTimestamp: 1_700_000_000 }));
  });

  it('ignores a log from an address that is not a known venue without any RPC call', async () => {
    const fake = fakeSource();
    const instance = await lane(fake);
    await instance.handleLogs([buyLog({}, unwatchedCurve)]);
    expect(await tradeRows()).toHaveLength(0);
    expect(fake.calls).toEqual({ getBlock: 0, getTransactionSender: 0 });
    expect(instance.stats()).toMatchObject({ received: 1, watched: 0 });
  });

  it('skips a log whose block hash is not the one the node reports now (a reorg race)', async () => {
    const fake = fakeSource();
    fake.header = { number: 5000n, hash: `0x${'99'.repeat(32)}`, timestamp: 1_700_000_000 };
    const instance = await lane(fake);
    await instance.handleLogs([buyLog()]);
    expect(await tradeRows()).toHaveLength(0);
    expect(instance.stats().skipped).toBe(1);
  });

  it('writes nothing when the header or the sender cannot be had, and never invents a trader', async () => {
    const noHeader = fakeSource();
    noHeader.header = null;
    const a = await lane(noHeader);
    await a.handleLogs([buyLog()]);
    expect(noHeader.calls.getBlock).toBe(3); // retried, then gave up
    const noSender = fakeSource();
    noSender.sender = null;
    const b = await lane(noSender);
    await b.handleLogs([buyLog()]);
    expect(await tradeRows()).toHaveLength(0);
    expect(a.stats().skipped + b.stats().skipped).toBe(2);
  });

  it('delivers the same event twice (WebSocket, then sweep) as one row and one announcement', async () => {
    const fake = fakeSource();
    const log = buyLog();
    fake.logs = [log];
    const instance = await lane(fake);
    await instance.handleLogs([log]);
    await instance.handleLogs([log]);
    await instance.sweepOnce(); // the lane's saved block is 5000 and the fake head is 5100: it scans 5001..5098, where the fake has no log
    await settle();
    expect(await tradeRows()).toHaveLength(1);
    expect(notifications.filter((n) => n.type === 'trade.created')).toHaveLength(1);
    expect(fake.calls.getTransactionSender).toBe(1); // the repeat was recognised before any lookup
  });

  it('deletes the row and announces launch.changed when the node reports the log removed', async () => {
    const fake = fakeSource();
    const log = buyLog();
    const instance = await lane(fake);
    await instance.handleLogs([log]);
    expect(await tradeRows()).toHaveLength(1);
    notifications.length = 0;
    await instance.handleLogs([{ ...log, removed: true }]);
    await settle();
    expect(await tradeRows()).toHaveLength(0);
    expect(notifications).toContainEqual(expect.objectContaining({ type: 'launch.changed', chainId, tokenAddress: token }));
    expect(instance.stats().removed).toBe(1);
  });

  it('fills a gap with getLogs from its saved block, in chunks, and resumes from there after a restart', async () => {
    const fake = fakeSource();
    const log = buyLog({ blockNumber: 5010n });
    fake.header = { number: 5010n, hash: blockHash, timestamp: 1_700_000_050 };
    fake.logs = [log];
    fake.head = 5100n;
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const getLogs = vi.spyOn(fake, 'getLogs');
    const instance = await lane(fake, { sweepChunkBlocks: 50n, sweepLagBlocks: 2n });
    await instance.sweepOnce();
    expect(getLogs.mock.calls.map(([from, to]) => [from, to])).toEqual([[5001n, 5050n], [5051n, 5098n]]);
    expect(await tradeRows()).toHaveLength(1);
    expect((await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId)))[0]?.lastBlock).toBe(5098n);
    const restarted = await lane(fake, { sweepChunkBlocks: 50n });
    getLogs.mockClear();
    await restarted.sweepOnce();
    expect(getLogs).not.toHaveBeenCalled(); // nothing new since 5098
  });

  it('skips a gap larger than the limit instead of scanning it', async () => {
    const fake = fakeSource();
    fake.head = 90_000n;
    await db.insert(fastLaneState).values({ chainId, lastBlock: 1_000n });
    const getLogs = vi.spyOn(fake, 'getLogs');
    const instance = await lane(fake, { maxGapBlocks: 20_000n });
    await instance.sweepOnce();
    expect(getLogs).not.toHaveBeenCalled();
    expect((await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId)))[0]?.lastBlock).toBe(89_998n);
  });

  it('counts a failed getLogs and retries the same range on the next sweep', async () => {
    const fake = fakeSource();
    await db.insert(fastLaneState).values({ chainId, lastBlock: 5000n });
    const getLogs = vi.spyOn(fake, 'getLogs').mockRejectedValueOnce(new Error('rate limited'));
    const instance = await lane(fake);
    await instance.sweepOnce();
    expect(instance.stats().errors).toBe(1);
    await instance.sweepOnce();
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs.mock.calls[1]![0]).toBe(5001n);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/fastLane/runner`
Expected: FAIL — cannot find `./runner.js`.

- [ ] **Step 3: Implement `be/src/fastLane/runner.ts`:**

```ts
import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { applyLiveRows, type LiveEntry } from '../envioSync/incrementalSync.js';
import { classifyLog, decodeLiveLog, type FastLog } from './decode.js';
import { advanceLaneBlock, readLaneBlock, recordFastRows, removeLaneTrade } from './store.js';
import { EMPTY_WATCH_SET, isWatched, loadWatchSet, type WatchSet } from './watchSet.js';

export interface BlockHeader { number: bigint; hash: string; timestamp: number }
export interface LaneChainSource {
  getBlock(blockNumber: bigint): Promise<BlockHeader | null>;
  getTransactionSender(txHash: string): Promise<string | null>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<FastLog[]>;
  getBlockNumber(): Promise<bigint>;
  subscribeLogs(onLogs: (logs: FastLog[]) => void, onError: (error: Error) => void): () => void;
}
export interface FastLaneOptions {
  chainId: number;
  sweepEveryMs?: number; watchRefreshEveryMs?: number; sweepLagBlocks?: bigint; maxGapBlocks?: bigint; sweepChunkBlocks?: bigint;
  lookupRetries?: number; lookupRetryDelayMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface FastLaneStats { received: number; watched: number; applied: number; unresolved: number; skipped: number; removed: number; errors: number; sweeps: number }
export interface FastLane {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleLogs(logs: readonly FastLog[]): Promise<void>;
  sweepOnce(): Promise<void>;
  reloadWatchSet(): Promise<void>;
  stats(): FastLaneStats;
}

const HANDLED_KEYS_MAX = 5_000;
const CACHE_MAX = 512;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as K);
}

export function createFastLane(deps: { source: LaneChainSource; db: Database; pool: Pool }, options: FastLaneOptions): FastLane {
  const { source, db, pool } = deps;
  const { chainId } = options;
  const sweepEveryMs = options.sweepEveryMs ?? 10_000;
  const watchRefreshEveryMs = options.watchRefreshEveryMs ?? 10_000;
  const sweepLagBlocks = options.sweepLagBlocks ?? 2n;
  const maxGapBlocks = options.maxGapBlocks ?? 20_000n;
  const sweepChunkBlocks = options.sweepChunkBlocks ?? 2_000n;
  const lookupRetries = options.lookupRetries ?? 3;
  const lookupRetryDelayMs = options.lookupRetryDelayMs ?? 100;
  const log = options.log ?? (() => {});
  const counters: FastLaneStats = { received: 0, watched: 0, applied: 0, unresolved: 0, skipped: 0, removed: 0, errors: 0, sweeps: 0 };

  let watch: WatchSet = EMPTY_WATCH_SET;
  let lastSwept: bigint | null = null;
  const headers = new Map<string, BlockHeader>();
  const senders = new Map<string, string>();
  const handled = new Set<string>(); // `${txHash}:${logIndex}` of logs this process already applied
  let queue: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];

  // Everything that touches the database runs one task at a time, in arrival order.
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task).catch((error) => { counters.errors += 1; log('fast lane task failed', { error: (error as Error).message }); });
    return queue;
  }

  async function lookup<T>(find: () => Promise<T | null>): Promise<T | null> {
    for (let attempt = 0; attempt < lookupRetries; attempt += 1) {
      try {
        const found = await find();
        if (found !== null) return found;
      } catch { /* retried; a lookup that keeps failing skips the log */ }
      if (attempt < lookupRetries - 1) await sleep(lookupRetryDelayMs);
    }
    return null;
  }
  async function getHeader(blockNumber: bigint): Promise<BlockHeader | null> {
    const cached = headers.get(blockNumber.toString());
    if (cached) return cached;
    const header = await lookup(() => source.getBlock(blockNumber));
    if (header) { headers.set(blockNumber.toString(), header); trim(headers, CACHE_MAX); }
    return header;
  }
  async function getSender(txHash: string): Promise<string | null> {
    const cached = senders.get(txHash);
    if (cached) return cached;
    const sender = await lookup(() => source.getTransactionSender(txHash));
    if (sender) { senders.set(txHash, sender); trim(senders, CACHE_MAX); }
    return sender;
  }

  async function processBlock(blockNumber: bigint, blockLogs: FastLog[]): Promise<void> {
    const keyOf = (entry: FastLog) => `${entry.transactionHash.toLowerCase()}:${entry.logIndex}`;
    const candidates = blockLogs
      .map((entry) => ({ entry, cls: classifyLog(entry) }))
      .filter((item): item is { entry: FastLog; cls: NonNullable<ReturnType<typeof classifyLog>> } => item.cls !== null && isWatched(watch, item.cls))
      .filter((item) => !handled.has(keyOf(item.entry)))
      .sort((a, b) => a.entry.logIndex - b.entry.logIndex);
    counters.watched += candidates.length;
    if (candidates.length === 0) return;
    const header = await getHeader(blockNumber);
    if (!header) { counters.skipped += candidates.length; return; }
    const entries: LiveEntry[] = [];
    const keys: string[] = [];
    for (const { entry } of candidates) {
      if (header.hash.toLowerCase() !== entry.blockHash.toLowerCase()) { counters.skipped += 1; continue; }
      const from = await getSender(entry.transactionHash);
      if (!from) { counters.skipped += 1; continue; }
      const decoded = decodeLiveLog(entry, { chainId, timestamp: header.timestamp, txFrom: from });
      if (!decoded) { counters.skipped += 1; continue; }
      entries.push(decoded);
      keys.push(keyOf(entry));
    }
    if (entries.length === 0) return;
    const result = await applyLiveRows(db, chainId, entries);
    counters.applied += result.applied; counters.unresolved += result.unresolved; counters.skipped += result.skipped;
    await recordFastRows(db, chainId, entries.filter((_, index) => result.outcomes[index] === 'applied'));
    keys.forEach((key, index) => { if (result.outcomes[index] === 'applied') handled.add(key); });
    while (handled.size > HANDLED_KEYS_MAX) handled.delete(handled.values().next().value as string);
    await advanceLaneBlock(db, chainId, blockNumber);
  }

  async function processLogs(logs: readonly FastLog[]): Promise<void> {
    counters.received += logs.length;
    for (const removed of logs.filter((entry) => entry.removed)) {
      try {
        if (await removeLaneTrade(db, chainId, { txHash: removed.transactionHash, logIndex: removed.logIndex, blockHash: removed.blockHash })) counters.removed += 1;
        handled.delete(`${removed.transactionHash.toLowerCase()}:${removed.logIndex}`);
      } catch (error) { counters.errors += 1; log('could not remove a reorged trade', { error: (error as Error).message }); }
    }
    const byBlock = new Map<bigint, FastLog[]>();
    for (const entry of logs) {
      if (entry.removed) continue;
      byBlock.set(entry.blockNumber, [...(byBlock.get(entry.blockNumber) ?? []), entry]);
    }
    for (const blockNumber of [...byBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      try { await processBlock(blockNumber, byBlock.get(blockNumber)!); }
      catch (error) { counters.errors += 1; log('could not apply a block of trades', { blockNumber: blockNumber.toString(), error: (error as Error).message }); }
    }
  }

  async function sweep(): Promise<void> {
    const head = await source.getBlockNumber();
    const to = head - sweepLagBlocks;
    if (lastSwept === null) lastSwept = (await readLaneBlock(db, chainId)) ?? to; // a lane that never ran starts here, it does not backfill
    if (to <= lastSwept) return;
    const from = lastSwept + 1n;
    if (to - from + 1n > maxGapBlocks) {
      log('gap larger than the limit; skipping ahead, Envio covers it', { from: from.toString(), to: to.toString() });
      lastSwept = to;
      await advanceLaneBlock(db, chainId, to);
      return;
    }
    for (let start = from; start <= to; start += sweepChunkBlocks) {
      const end = start + sweepChunkBlocks - 1n < to ? start + sweepChunkBlocks - 1n : to;
      await processLogs(await source.getLogs(start, end));
    }
    lastSwept = to;
    await advanceLaneBlock(db, chainId, to);
    counters.sweeps += 1;
  }

  async function reloadWatchSet(): Promise<void> {
    watch = await loadWatchSet(pool, chainId);
  }

  return {
    async start() {
      await reloadWatchSet();
      lastSwept = await readLaneBlock(db, chainId);
      unsubscribe = source.subscribeLogs((logs) => { void enqueue(() => processLogs(logs)); }, (error) => { counters.errors += 1; log('log subscription error', { error: error.message }); });
      timers.push(setInterval(() => { void reloadWatchSet().catch((error) => log('watch set refresh failed', { error: (error as Error).message })); }, watchRefreshEveryMs));
      timers.push(setInterval(() => { void enqueue(sweep); }, sweepEveryMs));
    },
    async stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      unsubscribe?.();
      unsubscribe = null;
      await queue;
    },
    handleLogs: (logs) => enqueue(() => processLogs(logs)),
    sweepOnce: () => enqueue(sweep),
    reloadWatchSet,
    stats: () => ({ ...counters }),
  };
}
```
- [ ] **Step 4: Run it and see it pass**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/fastLane && npx tsc --noEmit && npx eslint src/fastLane`
Expected: PASS. If the "sweep with no saved block" assertion in the duplicate test is unclear, note that `sweepOnce` there starts from `to` and scans nothing, which is what the test relies on.

- [ ] **Step 5: Commit**

```bash
git add be/src/fastLane/runner.ts be/src/fastLane/runner.integration.test.ts
git commit -m "feat(fast-lane): runner that applies watched trades, sweeps gaps and handles removed logs"
```

---

### Task 6: viem chain source, CLI, measurement command, scripts

**Files:**
- Create: `be/src/fastLane/chainSource.ts`, `be/src/cli/runFastLane.ts`, `be/src/cli/measureFastLane.ts`
- Modify: `be/package.json` (scripts), `be/.env.example`
- Test: `be/src/fastLane/chainSource.test.ts`

**Interfaces:**
- Consumes: `LaneChainSource`, `BlockHeader` (Task 5); `FAST_LANE_EVENTS`, `FastLog` (Task 3); `getChainConfig`, `rpcUrlFor` (`chains/registry.ts`), `CHAIN_CONFIGS`; `robinhood` chain definition.
- Produces: `createViemChainSource(chain: Chain, urls: { http: string; ws: string }): LaneChainSource`, plus `toFastLog(log): FastLog | null` (exported for the test).

- [ ] **Step 1: Write the failing test** — `be/src/fastLane/chainSource.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toFastLog } from './chainSource.js';

const base = {
  address: '0xAbC0000000000000000000000000000000000001', topics: [`0x${'11'.repeat(32)}`], data: '0x',
  blockNumber: 12n, blockHash: `0x${'22'.repeat(32)}`, transactionHash: `0x${'33'.repeat(32)}`, logIndex: 4, removed: false,
} as never;

describe('toFastLog', () => {
  it('maps a viem log and keeps the removed flag', () => {
    expect(toFastLog(base)).toEqual({ address: '0xAbC0000000000000000000000000000000000001', topics: [`0x${'11'.repeat(32)}`], data: '0x',
      blockNumber: 12n, blockHash: `0x${'22'.repeat(32)}`, transactionHash: `0x${'33'.repeat(32)}`, logIndex: 4, removed: false });
    expect(toFastLog({ ...(base as object), removed: true } as never)?.removed).toBe(true);
  });
  it('drops a log that is not mined yet (null block, hash or index)', () => {
    expect(toFastLog({ ...(base as object), blockNumber: null } as never)).toBeNull();
    expect(toFastLog({ ...(base as object), blockHash: null } as never)).toBeNull();
    expect(toFastLog({ ...(base as object), logIndex: null } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd be && npx vitest run src/fastLane/chainSource.test.ts`
Expected: FAIL — cannot find `./chainSource.js`.

- [ ] **Step 3: Implement.**

`be/src/fastLane/chainSource.ts`:
```ts
import { createPublicClient, http, webSocket, type Chain, type Log } from 'viem';
import { FAST_LANE_EVENTS, type FastLog } from './decode.js';
import type { LaneChainSource } from './runner.js';

export function toFastLog(log: Log): FastLog | null {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) return null;
  return {
    address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber, blockHash: log.blockHash,
    transactionHash: log.transactionHash, logIndex: log.logIndex, removed: log.removed,
  };
}

/** The lane's view of the chain: WebSocket for the live log stream, plain HTTP for everything it asks for by key. */
export function createViemChainSource(chain: Chain, urls: { http: string; ws: string }): LaneChainSource {
  const rpc = createPublicClient({ chain, transport: http(urls.http) });
  const socket = createPublicClient({ chain, transport: webSocket(urls.ws, { keepAlive: true, reconnect: true }) });
  return {
    async getBlock(blockNumber) {
      const block = await rpc.getBlock({ blockNumber });
      return block.number === null || block.hash === null ? null : { number: block.number, hash: block.hash, timestamp: Number(block.timestamp) };
    },
    async getTransactionSender(txHash) {
      const transaction = await rpc.getTransaction({ hash: txHash as `0x${string}` });
      return transaction.from;
    },
    async getLogs(fromBlock, toBlock) {
      const logs = await rpc.getLogs({ events: FAST_LANE_EVENTS, fromBlock, toBlock });
      return logs.flatMap((log) => toFastLog(log) ?? []);
    },
    getBlockNumber: () => rpc.getBlockNumber(),
    subscribeLogs(onLogs, onError) {
      return socket.watchEvent({
        events: FAST_LANE_EVENTS,
        onLogs: (logs) => onLogs(logs.flatMap((log) => toFastLog(log) ?? [])),
        onError,
      });
    },
  };
}
```
(`getLogs` with `events` must not pass an `address`; if viem's typing rejects the readonly tuple, cast `FAST_LANE_EVENTS as never` at those two call sites — never loosen anything else.)

`be/src/cli/runFastLane.ts`:
```ts
import { createDatabase } from '../db/client.js';
import { getChainConfig, rpcUrlFor } from '../chains/registry.js';
import { createViemChainSource } from '../fastLane/chainSource.js';
import { createFastLane } from '../fastLane/runner.js';
import { robinhood } from '../chains/robinhood.js';

// The WebSocket fast lane (docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md). Off unless FAST_LANE_ENABLED=true.
if (process.env.FAST_LANE_ENABLED !== 'true') {
  console.log('Fast lane is off (set FAST_LANE_ENABLED=true to run it).');
  process.exit(0);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const wsUrl = process.env.RH_WS_RPC_URL;
if (!wsUrl) throw new Error('RH_WS_RPC_URL is required');
const chain = getChainConfig(robinhood.id)!;
const { db, pool } = createDatabase(databaseUrl);
const source = createViemChainSource(robinhood, { http: rpcUrlFor(chain, process.env), ws: wsUrl });
const lane = createFastLane({ source, db, pool }, {
  chainId: chain.id,
  maxGapBlocks: process.env.FAST_LANE_MAX_GAP_BLOCKS ? BigInt(process.env.FAST_LANE_MAX_GAP_BLOCKS) : undefined,
  log: (message, fields) => console.log(new Date().toISOString(), message, fields ?? ''),
});
await lane.start();
console.log(new Date().toISOString(), `fast lane running for chain ${chain.id}`);
const report = setInterval(() => console.log(new Date().toISOString(), 'fast lane stats', lane.stats()), 30_000);
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(report);
  await lane.stop();
  await pool.end();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
```

`be/src/cli/measureFastLane.ts` (step 0 of the spec: how many logs per second per event, and how many of them are watched):
```ts
import { createDatabase } from '../db/client.js';
import { getChainConfig, rpcUrlFor } from '../chains/registry.js';
import { robinhood } from '../chains/robinhood.js';
import { createViemChainSource } from '../fastLane/chainSource.js';
import { classifyLog } from '../fastLane/decode.js';
import { isWatched, loadWatchSet } from '../fastLane/watchSet.js';

// Counts, for `seconds`, how many logs of each trade event the chain emits and how many belong to a known launch venue. Read-only.
const seconds = Number(process.argv[2] ?? 60);
const databaseUrl = process.env.DATABASE_URL;
const wsUrl = process.env.RH_WS_RPC_URL;
if (!databaseUrl || !wsUrl) throw new Error('DATABASE_URL and RH_WS_RPC_URL are required');
const chain = getChainConfig(robinhood.id)!;
const { pool } = createDatabase(databaseUrl);
const watch = await loadWatchSet(pool, chain.id);
const source = createViemChainSource(robinhood, { http: rpcUrlFor(chain, process.env), ws: wsUrl });
const totals: Record<string, { all: number; watched: number }> = {};
const stop = source.subscribeLogs((logs) => {
  for (const log of logs) {
    const cls = classifyLog(log);
    if (!cls) continue;
    const entry = (totals[cls.event] ??= { all: 0, watched: 0 });
    entry.all += 1;
    if (isWatched(watch, cls)) entry.watched += 1;
  }
}, (error) => console.error('subscription error', error.message));
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
stop();
console.log(JSON.stringify({ seconds, venues: { curve: watch.curve.size, v3_pool: watch.v3_pool.size, v4_pool: watch.v4_pool.size },
  perSecond: Object.fromEntries(Object.entries(totals).map(([event, count]) => [event, { all: +(count.all / seconds).toFixed(2), watched: +(count.watched / seconds).toFixed(2) }])) }, null, 1));
await pool.end();
process.exit(0);
```

`be/package.json` scripts (next to `launch-stats:live`):
```json
"fast-lane:run": "tsx --env-file-if-exists=.env src/cli/runFastLane.ts",
"fast-lane:measure": "tsx --env-file-if-exists=.env src/cli/measureFastLane.ts",
"fast-lane:parity": "tsx --env-file-if-exists=.env src/cli/compareFastLane.ts",
```
(`fast-lane:parity` is created in Task 8.) Append to `be/.env.example`:
```
# WebSocket fast lane (off by default; see docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md).
# FAST_LANE_ENABLED=true
# RH_WS_RPC_URL=wss://...   # a private provider URL: never commit it
# FAST_LANE_MAX_GAP_BLOCKS=20000
```

- [ ] **Step 4: Run tests and checks**

Run: `cd be && npx vitest run src/fastLane/chainSource.test.ts && npx tsc --noEmit && npx eslint src`
Expected: PASS, clean.

- [ ] **Step 5: Measure on the real chain (needs the WebSocket URL — it is `ENVIO_RH_WS_RPC_URL` in `envio/.env`; pass it through the environment, do not copy it into any file)**

Run (from `be/`, with `RH_WS_RPC_URL` exported from that value and the dev `DATABASE_URL`): `npm run fast-lane:measure -- 90`
Expected: a JSON with logs per second per event. Write the printed numbers into the spec's "Design" section 1 in Task 9. If `V3Swap.all` is more than ~200/s, stop and report: the topic-only subscription then needs a different filter.

- [ ] **Step 6: Commit**

```bash
git add be/src/fastLane/chainSource.ts be/src/fastLane/chainSource.test.ts be/src/cli/runFastLane.ts be/src/cli/measureFastLane.ts be/package.json be/.env.example
git commit -m "feat(fast-lane): viem chain source, run and measure commands"
```

---

### Task 7: Say which lane delivered an event (`via`) and show the delay per lane

**Files:**
- Modify: `be/src/envioSync/notifyChanges.ts`, `be/src/envioSync/incrementalSync.ts` (`applyLiveRows`), `be/src/api/events.ts`, `be/src/api/pgEvents.ts`, `be/src/api/eventMetrics.ts`
- Test: `be/src/api/pgEvents.test.ts`, `be/src/api/eventMetrics.test.ts`, `be/src/envioSync/incrementalSync.integration.test.ts`

**Interfaces:**
- Produces: `ChangeNotification.via?: 'fast' | 'envio'`, `ApiEvent.via?: 'fast' | 'envio'`; the pg payload carries `via` when set; `GET /v1/metrics` entries gain `lagByVia: { fast: LagStats; envio: LagStats }` (an event without `via` counts as `envio`). `applyLiveRows` tags its changes `via: 'fast'`.

- [ ] **Step 1: Write the failing tests.**

In `pgEvents.test.ts` append inside the describe:
```ts
  it('carries which lane delivered an event and rejects an unknown lane', () => {
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"via":"fast"}')).toEqual({ type: 'trade.created', chainId: 4663, via: 'fast' });
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"via":"carrier-pigeon"}')).toBeNull();
  });
```
In `eventMetrics.test.ts` append inside the describe:
```ts
  it('splits the delay by the lane that delivered the event, counting an untagged event as Envio', () => {
    const nowMs = 1_000_000_000_000;
    const bus = new ApiEventBus();
    const metrics = createEventMetrics(bus, () => nowMs);
    const token = '0x1111111111111111111111111111111111111111';
    bus.publish({ type: 'trade.created', chainId: 1, tokenAddress: token, blockTimestamp: 1_000_000_000 - 1, via: 'fast' });
    bus.publish({ type: 'trade.created', chainId: 1, tokenAddress: token, blockTimestamp: 1_000_000_000 - 3 });
    const entry = metrics.snapshot().events['trade.created']!;
    expect(entry.lagByVia.fast).toMatchObject({ samples: 1, p50Seconds: 1 });
    expect(entry.lagByVia.envio).toMatchObject({ samples: 1, p50Seconds: 3 });
    expect(entry.lag.samples).toBe(2);
  });
```
In `incrementalSync.integration.test.ts`, extend the first `applyLiveRows` test: after the first call assert `expect(announced).toEqual([expect.objectContaining({ kind: 'trade.created', via: 'fast' })]);` (adjust the existing `announced` expectation).

- [ ] **Step 2: Run them and see them fail**

Run: `cd be && npx vitest run src/api/pgEvents.test.ts src/api/eventMetrics.test.ts && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/envioSync/incrementalSync`
Expected: FAIL (no `via` anywhere).

- [ ] **Step 3: Implement.**
  - `notifyChanges.ts`: add `via?: 'fast' | 'envio'` to `ChangeNotification` and `...(change.via ? { via: change.via } : {})` to the payload object.
  - `incrementalSync.ts` `applyLiveRows`: `await notifyChanged(tx, changes.map((change) => ({ ...change, via: 'fast' as const })));`
  - `events.ts`: `via?: 'fast' | 'envio'` on `ApiEvent`.
  - `pgEvents.ts`: reject when `event.via !== undefined && event.via !== 'fast' && event.via !== 'envio'`; copy `via` into the returned event when it is one of the two.
  - `eventMetrics.ts`: per type keep `lagsByVia: { fast: number[]; envio: number[] }` next to `lags`; on an event with `blockTimestamp` push the delay to both `lags` and `lagsByVia[event.via ?? 'envio']` (same 200-sample cap each); extract the stats computation into a helper `lagStats(samples)` used for `lag` and for both `lagByVia` entries; add `lagByVia: { fast: LagStats; envio: LagStats }` to the exported entry type.

- [ ] **Step 4: Run them and see them pass**

Run: `cd be && npx vitest run && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/envioSync src/fastLane && npx tsc --noEmit && npx eslint src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add be/src/envioSync/notifyChanges.ts be/src/envioSync/incrementalSync.ts be/src/api/events.ts be/src/api/pgEvents.ts be/src/api/eventMetrics.ts be/src/api/pgEvents.test.ts be/src/api/eventMetrics.test.ts be/src/envioSync/incrementalSync.integration.test.ts
git commit -m "feat(api): /v1/metrics shows the delay of the fast lane and of Envio separately"
```

---

### Task 8: Parity command

**Files:**
- Create: `be/src/fastLane/parity.ts`, `be/src/cli/compareFastLane.ts`
- Test: `be/src/fastLane/parity.integration.test.ts`

**Interfaces:**
- Consumes: `fastLaneRows` table (Task 4); `readRawRowByTxLog` (`envioSync/incrementalPage.ts`); `readEnvioProgress` (`envioSync/envioDb.ts`); `DEFAULT_STREAM_TABLES` (`envioSync/incrementalSync.ts`).
- Produces:
```ts
export interface ParityMismatch { txHash: string; logIndex: number; stream: string; fields: { field: string; lane: string; envio: string }[] }
export interface ParityReport { checked: number; matching: number; mismatched: ParityMismatch[]; missingInEnvio: { txHash: string; logIndex: number; stream: string }[]; pending: number }
export function runParity(appDb: Database, envioPool: Pool, options: { chainId: number; olderThanSeconds: number; processedBlock: bigint; tables?: Partial<Record<LiveStream, string>>; limit?: number }): Promise<ParityReport>
```
Rules: a lane row younger than `olderThanSeconds`, or above `processedBlock`, is `pending` and kept. Otherwise it is looked up in Envio's raw table for its stream by `(chainId, txHash, logIndex)`: absent → `missingInEnvio` (a real gap: Envio never produced the event — for example Envio's relevance filter dropped it); present → every field of the lane's raw row except `id` is compared as a lower-cased string; any difference → `mismatched`. Checked rows (matching, mismatched, missing) are deleted from `fast_lane_rows` only when they match; mismatched and missing rows are kept so the report stays reproducible.

- [ ] **Step 1: Write the failing test** — `be/src/fastLane/parity.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { fastLaneRows } from '../db/schema.js';
import { runParity } from './parity.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const chainId = 996642;
const table = 'envio_fixture_parity."RawCurveTrade"';
const tables = { 'v2-curve': table };

const raw = (suffix: string, overrides: Record<string, unknown> = {}) => ({
  id: `${chainId}-b-${suffix}-1`, chainId, curveAddress: '0x7f00000000000000000000000000000000000001', side: 'buy', tokenAmountRaw: '1000', quoteAmountRaw: '2000',
  feeRaw: '0', taxRaw: '0', txFrom: '0x1111111111111111111111111111111111111111', blockNumber: '900', blockHash: `0x${'bb'.repeat(32)}`,
  txHash: `0x${suffix.repeat(32)}`, logIndex: 1, timestamp: 1_700_000_000, ...overrides,
});
async function laneRow(entry: ReturnType<typeof raw>, ageSeconds = 600): Promise<void> {
  await db.insert(fastLaneRows).values({
    chainId, txHash: entry.txHash, logIndex: entry.logIndex, stream: 'v2-curve', raw: entry, blockNumber: BigInt(entry.blockNumber),
    writtenAt: new Date(Date.now() - ageSeconds * 1000),
  });
}
async function envioRow(entry: ReturnType<typeof raw>): Promise<void> {
  await envioPool.query(`INSERT INTO ${table} (id, "chainId", "curveAddress", side, "tokenAmountRaw", "quoteAmountRaw", "feeRaw", "taxRaw", "txFrom",
    "blockNumber", "blockHash", "txHash", "logIndex", "timestamp") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [entry.id, entry.chainId, entry.curveAddress, entry.side, entry.tokenAmountRaw, entry.quoteAmountRaw, entry.feeRaw, entry.taxRaw, entry.txFrom,
    entry.blockNumber, entry.blockHash, entry.txHash, entry.logIndex, entry.timestamp]);
}
const options = { chainId, olderThanSeconds: 120, processedBlock: 1000n, tables };

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_parity');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric,
    "quoteAmountRaw" numeric, "feeRaw" numeric, "taxRaw" numeric, "txFrom" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
});
beforeEach(async () => {
  await envioPool.query(`TRUNCATE ${table}`);
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
});
afterAll(async () => {
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await envioPool.query('DROP SCHEMA envio_fixture_parity CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('runParity', () => {
  it('counts an identical row as matching and forgets it', async () => {
    const entry = raw('a1');
    await laneRow(entry); await envioRow(entry);
    expect(await runParity(db, envioPool, options)).toMatchObject({ checked: 1, matching: 1, mismatched: [], missingInEnvio: [], pending: 0 });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(0);
  });

  it('reports every field that differs, such as a wrong trader, and keeps the row', async () => {
    const entry = raw('a2');
    await laneRow(entry); await envioRow({ ...entry, txFrom: '0x2222222222222222222222222222222222222222', quoteAmountRaw: '2001' });
    const report = await runParity(db, envioPool, options);
    expect(report.matching).toBe(0);
    expect(report.mismatched).toEqual([{ txHash: entry.txHash, logIndex: 1, stream: 'v2-curve', fields: expect.arrayContaining([
      { field: 'txFrom', lane: '0x1111111111111111111111111111111111111111', envio: '0x2222222222222222222222222222222222222222' },
      { field: 'quoteAmountRaw', lane: '2000', envio: '2001' },
    ]) }]);
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(1);
  });

  it('reports an event Envio never produced, once Envio has processed that block', async () => {
    await laneRow(raw('a3'));
    expect((await runParity(db, envioPool, options)).missingInEnvio).toEqual([{ txHash: `0x${'a3'.repeat(32)}`, logIndex: 1, stream: 'v2-curve' }]);
  });

  it('leaves a row alone while it is young or beyond the block Envio has processed', async () => {
    await laneRow(raw('a4'), 5); // written 5 s ago
    await laneRow(raw('a5', { blockNumber: '1500' })); // block 1500 > processed 1000
    expect(await runParity(db, envioPool, options)).toMatchObject({ checked: 0, pending: 2, missingInEnvio: [] });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(2);
  });
});
```
(Fix the `raw` helper's `txHash` so `suffix.repeat(32)` yields a 64-hex string for two-character suffixes such as `a1` — it does: 2 chars × 32.)

- [ ] **Step 2: Run it and see it fail**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/fastLane/parity`
Expected: FAIL — cannot find `./parity.js`.

- [ ] **Step 3: Implement `be/src/fastLane/parity.ts`:**

```ts
import type { Pool } from 'pg';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fastLaneRows } from '../db/schema.js';
import { readRawRowByTxLog } from '../envioSync/incrementalPage.js';
import { DEFAULT_STREAM_TABLES, type LiveStream } from '../envioSync/incrementalSync.js';

export interface ParityMismatch { txHash: string; logIndex: number; stream: string; fields: { field: string; lane: string; envio: string }[] }
export interface ParityReport {
  checked: number; matching: number; mismatched: ParityMismatch[]; missingInEnvio: { txHash: string; logIndex: number; stream: string }[]; pending: number;
}
export interface ParityOptions {
  chainId: number; olderThanSeconds: number; processedBlock: bigint; tables?: Partial<Record<LiveStream, string>>; limit?: number;
}

const norm = (value: unknown) => String(value).toLowerCase();

/**
 * Compares the raw rows the fast lane fed in with the rows Envio produced for the same event. Equal raw rows give equal trades because both go
 * through the same `applyRow`; this is the guard against the lane's decoder drifting from Envio's handler.
 */
export async function runParity(appDb: Database, envioPool: Pool, options: ParityOptions): Promise<ParityReport> {
  const tables = { ...DEFAULT_STREAM_TABLES, ...options.tables };
  const cutoff = new Date(Date.now() - options.olderThanSeconds * 1000);
  const all = await appDb.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, options.chainId)).limit(options.limit ?? 5_000);
  const report: ParityReport = { checked: 0, matching: 0, mismatched: [], missingInEnvio: [], pending: 0 };
  for (const row of all) {
    if (row.writtenAt >= cutoff || row.blockNumber > options.processedBlock) { report.pending += 1; continue; }
    report.checked += 1;
    const envio = await readRawRowByTxLog(envioPool, tables[row.stream as LiveStream], options.chainId, row.txHash, row.logIndex);
    if (!envio) { report.missingInEnvio.push({ txHash: row.txHash, logIndex: row.logIndex, stream: row.stream }); continue; }
    const fields = Object.entries(row.raw)
      .filter(([field]) => field !== 'id')
      .filter(([field, value]) => norm(value) !== norm(envio[field]))
      .map(([field, value]) => ({ field, lane: String(value), envio: String(envio[field]) }));
    if (fields.length > 0) { report.mismatched.push({ txHash: row.txHash, logIndex: row.logIndex, stream: row.stream, fields }); continue; }
    report.matching += 1;
    await appDb.delete(fastLaneRows).where(and(eq(fastLaneRows.chainId, options.chainId), eq(fastLaneRows.txHash, row.txHash), eq(fastLaneRows.logIndex, row.logIndex)));
  }
  return report;
}
```
(Remove the unused `lt` import. `DEFAULT_STREAM_TABLES` is already exported from `incrementalSync.ts`.)

`be/src/cli/compareFastLane.ts`:
```ts
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { readEnvioProgress } from '../envioSync/envioDb.js';
import { runParity } from '../fastLane/parity.js';

// Compares what the fast lane wrote with what Envio produced. Exit code 1 when anything differs or is missing.
const databaseUrl = process.env.DATABASE_URL;
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!databaseUrl || !envioDatabaseUrl) throw new Error('DATABASE_URL and ENVIO_DATABASE_URL are required');
const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const { processedBlock } = await readEnvioProgress(envioPool);
const report = await runParity(db, envioPool, { chainId: 4663, olderThanSeconds: Number(process.env.FAST_LANE_PARITY_MIN_AGE_SECONDS ?? 300), processedBlock });
console.log(JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
await pool.end();
await envioPool.end();
process.exit(report.mismatched.length > 0 || report.missingInEnvio.length > 0 ? 1 : 0);
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd be && VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts src/fastLane && npx tsc --noEmit && npx eslint src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add be/src/fastLane/parity.ts be/src/fastLane/parity.integration.test.ts be/src/cli/compareFastLane.ts
git commit -m "feat(fast-lane): parity command comparing the lane's rows with Envio's"
```

---

### Task 9: Documentation, spec sync and final verification

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md`

- [ ] **Step 1: Update the spec** to match what was built: in "Design" replace the `newHeads` header cache by "a block header is fetched over HTTP once per block that holds a watched log and cached (512 blocks)"; replace the on-reconnect gap fill by "a 10 s sweep scans `last_block+1 .. head-2` with `eth_getLogs`, which also covers a reconnect; a lane that never ran starts at the head"; replace "moves into one exported function" by "`applyLiveRows` (next to `applyRow`) applies decoded rows; `applyEnvioPage` is unchanged"; put the Task 6 measurement numbers (logs per second per event, watched share, venue counts) into section 1; and set `Status: implemented, flag off by default`.

- [ ] **Step 2: README (Vietnamese)** — add a section after the "Đo độ trễ liên tục" paragraph describing: what the lane is, `FAST_LANE_ENABLED=true`, `RH_WS_RPC_URL`, `npm run -w be fast-lane:run`, `fast-lane:measure -- 90`, `fast-lane:parity` (exit code 1 on differences), that Envio stays the source of correctness, that `/v1/metrics` shows `lagByVia.fast` vs `lagByVia.envio`, and how to turn it off (unset the flag, stop the process; nothing else depends on it).

- [ ] **Step 3: CLAUDE.md** — one dated entry (2026-10-14, "WebSocket fast lane") stating: files (`be/src/fastLane/`), that it is off by default, the repair-fence fix in `incrementalRepair.ts`, `applyLiveRows`, tables `fast_lane_rows`/`fast_lane_state` (migration `0055`), what is out of scope (launches, lifecycle, `pool_trades`, metadata), and that success criteria are lane p50 < ~1.5 s with zero parity mismatches over 24 h (not yet measured on live data).

- [ ] **Step 4: Full verification**

Run:
```bash
cd be && npx tsc --noEmit && npx eslint src && npx vitest run
VOLUME_CURSOR_SECRET=x npx vitest run -c vitest.integration.config.ts
cd ../fe && npx tsc --noEmit && npx vitest run
```
Expected: everything green (no FE file changed; the FE run only confirms nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md
git commit -m "docs: the WebSocket fast lane (README, CLAUDE.md, spec sync)"
```

---

## Self-review notes

- **Spec coverage:** scope/streams (Tasks 2, 3), watch set and topic-only subscription (Tasks 3, 4, 6), header and sender lookups with skip-on-failure (Task 5), shared hydration (Task 2), idempotence and single announcement (Tasks 2, 5), `via` metrics (Task 7), repair-fence fix (Task 1), removed logs (Tasks 4, 5), sweep/gap and restart (Task 5), parity (Task 8), flag/config (Task 6), measurement step 0 (Task 6), docs (Task 9).
- **Not covered, deliberately:** launches/lifecycle/other pools/metadata (out of scope in the spec).
- **Types used across tasks:** `LiveStream`, `LiveEntry`, `ApplyLiveResult` (Task 2) → Tasks 3, 4, 5, 8; `FastLog`, `LogClass`, `classifyLog`, `decodeLiveLog`, `FAST_LANE_EVENTS` (Task 3) → Tasks 4, 5, 6; `WatchSet` helpers (Task 4) → Tasks 5, 6; `LaneChainSource`, `createFastLane` (Task 5) → Task 6; `fastLaneRows`/`fastLaneState` (Task 4) → Tasks 5, 8.
