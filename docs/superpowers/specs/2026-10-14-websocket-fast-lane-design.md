# Fast lane: official trades straight from the chain over WebSocket

Date: 2026-10-14. Status: implemented, flag off by default.

## Intent

Trades of launches should reach the database, and so the screen, in about a second after the block, not after Envio's HyperSync
round trip. The user's decision (2026-10-14): **a WebSocket lane writes the real rows; Envio keeps scanning afterwards to add what
the lane missed and to remove what turned out wrong.** Envio stays the source of correctness; the lane is only faster.

What was measured (2026-10-14, Robinhood Chain 4663):

- The chain makes about 8 blocks a second. A WebSocket `eth_subscribe` delivers a block header ~0.84 s (p50) after its timestamp and a log
  ~0.67 s after it (timestamps have 1 s resolution, so the real figure is ~0.3 s lower).
- Envio with an unmetered HyperSync token: chain block time -> row visible in the Envio DB p50 1.9 s, p90 3.25 s. On the free token
  (15 queries/min budget) it was ~40 s. The lane therefore gains about 1 s over a paid plan and ~40 s over the current one.
- Chain-wide logs per second, and those that belong to a known launch venue (90 s, development database's venues): V4 Swap 15.76 / 0.06;
  V3 Swap 13.28 / 0.16; CurveBuy 0.16 / 0; CurveSell 0.12 / 0. Watch set: 21,912 curve, 145,310 `v3_pool`, 79 `v4_pool` venues. So the
  topic-only subscription carries about 30 logs/s and only a trade every few seconds is a launch trade; the lane must drop the rest.

## Scope

In (phase 1): the four streams that become rows of `trades` for a launch's official venues:
`v1-swap` (Pons V1 V3-pool swaps), `v2-curve` (CurveBuy/CurveSell), `v2-buyback` (BuybackLocked), `v4-swap` (V4 swaps of a
graduated Pons pool). Chain 4663 only, behind a flag that is **off by default**.

Out (unchanged, still Envio only): launches and lifecycle transitions, V4 `Initialize`, the `Pools` section's other pools
(`pool_trades`), metadata, prices. A trade whose launch or venue is not in the database yet is dropped by the lane (Envio delivers it
later). Multi-chain: the lane takes its chain from `be/src/chains/registry.ts`, nothing else is hard-wired, but only 4663 is configured.

## Design

One new process, `npm run -w be fast-lane:run` (`be/src/cli/runFastLane.ts`), and a small module `be/src/fastLane/`.

```
chain --WS logs--> runner --decode--> raw row (Envio's shape) --applyRow--> trades --pg_notify--> API/SSE
chain --HTTP getBlock--> header cache (number -> hash, timestamp; 512 blocks)
chain --HTTP getTransactionByHash--> tx.from
chain --HTTP 10 s sweep getLogs--> gap fill (also after a reconnect)
```

1. **Subscription.** `eth_subscribe logs` with `topics[0]` in {CurveBuy, CurveSell, BuybackLocked, V3 `Swap`, V4 `Swap`} and no address
   filter (a 100k-address filter is not possible). There is no `newHeads` subscription. Each log is then kept only if its source is in the **watch set**:
   curve addresses (`venues.kind='curve'`), V3 pools (`v3_pool`), V4 pool ids (`v4_pool`), read from the app DB and refreshed every 10 s
   and on `launch.changed`. Before building this, step 0 counts the logs per second per topic on the real chain to size the filter cost.
2. **Decode to Envio's raw shape.** The lane builds the same `Record<string, unknown>` that `envio/src/EventHandlers.ts` writes for that
   event (`poolAddress`/`curveAddress`/`poolId`, amounts, `txFrom`, `blockNumber`, `blockHash`, `txHash`, `logIndex`, `timestamp`, the
   Envio `id`). `timestamp` and `blockHash` come from the header cache (a header is fetched over HTTP once per block that holds a watched log and cached,
   512 blocks; it is evicted when one of its logs is reported removed and re-fetched once before concluding a block-hash mismatch); `txFrom` comes from one `eth_getTransactionByHash` per kept log
   (batched, cached per tx). If a header or transaction cannot be had, the log is skipped, never guessed.
3. **Apply with the existing code.** `applyLiveRows` (in `incrementalSync.ts`, next to `applyRow`) applies decoded rows, with the
   volume invalidation and quote-asset enqueue that follow; `applyEnvioPage` is unchanged. The lane calls it per block, in
   `(blockNumber, logIndex)` order. So hydration (price fields, side, activity kind, trader)
   is the same code; there is no second decoder to keep in step. A row reported `unresolved` is dropped and counted, not queued.
4. **Idempotence.** Rows are inserted with `onConflictDoNothing` on the existing key `(chain_id, tx_hash, log_index)`. When Envio's tail
   lane later reads the same event it inserts nothing and announces nothing (already the behaviour: no duplicate `trade.created`).
5. **Announcement.** The same `notifyChanged` call announces `trade.created` (with the block timestamp). It also carries `via: 'fast'`
   (Envio's path `via: 'envio'`) so `GET /v1/metrics` can show the delay of each lane side by side.

### Keeping it correct

- **Missing rows.** Envio's tail/history lanes insert whatever the lane missed. Nothing in the lane has to be complete.
- **Wrong or reorged rows.** `incrementalRepair.ts` already compares the app's trades in a window below Envio's processed block
  (`fence`) with Envio's canonical keys and deletes a row whose `blockHash` differs. Today that app-side window has **no upper bound**:
  lane rows newer than the fence would look stale and be deleted. **Required change:** bound it with `blockNumber <= fence` for every
  stream. The lane additionally handles `removed: true` logs from the node by deleting that `(tx_hash, log_index, block_hash)` row.
- **Gaps.** A 10 s sweep scans `saved_block+1 .. head-2` with `eth_getLogs` (same filter, chunks of 2,000 blocks, the provider's limit),
  which also covers a reconnect. **Only the sweep advances the saved block** (the WebSocket path does not), so a restart can re-scan at most
  one sweep interval, deduplicated by the unique key. A lane that never ran starts at the head and does not backfill. If the gap is
  larger than 20,000 blocks it skips ahead; Envio covers it.
- **Parity.** The lane records the key of every row it writes in a small table, `fast_lane_rows(chain_id, tx_hash, log_index, written_at)`.
  `npm run -w be fast-lane:parity` compares each recorded row with the row Envio produced for the same key on every column, reports
  mismatches and missing keys, and deletes the entries it has checked. `trades` itself carries no marker.
- **Coverage and safe head** keep using Envio's progress, so blocks beyond the fence still show as not confirmed.
- **Order.** A row Envio adds late can sit before lane rows of the same bucket; the candle and volume workers already rebuild a bucket
  when any trade in it is inserted.

### Configuration

`FAST_LANE_ENABLED` (default `false`), `RH_WS_RPC_URL`, `RH_HTTP_RPC_URL`, `FAST_LANE_MAX_GAP_BLOCKS` (20000). The CLIs redact RPC URLs in every error message (`redact.ts`). Tables
`fast_lane_rows` and `fast_lane_state` come from migration `0055`. No change to the API or the
browser: they already react to `trade.created`.

## Testing

- Unit: decoder output equals the raw row Envio writes, for a recorded log of each of the five events (fixtures from real receipts); a log
  from an unwatched address, a missing header and a missing `tx.from` are skipped.
- Integration (test DB): lane rows then Envio rows for the same events give one row and one announcement; lane rows beyond the fence
  survive a repair pass; a lane row whose block was replaced is deleted by repair and by a `removed` log; gap fill after a simulated drop.
- Parity command on the real chain for a day before the flag is turned on for anyone.

## Rollout and success

Off by default. Turn it on locally, read `/v1/metrics` for both `via` values. Success: lane p50 chain -> API under ~1.5 s, **zero**
parity mismatches over 24 h, and no growth in unresolved-event backlog. If the lane misbehaves, set the flag off and restart nothing else:
Envio alone still produces every row.

## Risks

- Two decoders for the same event (the lane's and Envio's handler) can drift; the parity command and the fixture tests are the guard.
- Provider limits: log subscriptions and `getLogs` quota on the RPC plan; the WebSocket URL in `envio/.env` is a private key and must stay
  out of the repository.
- A bug that writes a wrong row Envio would also write identically is not caught by repair; the shared `applyRow` limits that class.

## Known limits

- Launch and lifecycle repair windows are still unbounded above the fence; the lane writes neither, so they are unaffected.
- The saved block is advanced only by the sweep.
- The parity command orders nothing (a limit without an order) and compares raw rows.
- viem errors outside the CLIs' own try/catch could still print a raw URL (there is no process-level handler yet).
- No live-trade latency of the lane has been measured; the success criteria above are targets.
