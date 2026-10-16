# Realtime charts and headline data

Date: 2026-10-16. Status: approved in conversation for implementation.

## Intent and scope

When a supported on-chain change reaches the WebSocket lane, the open launch or pool page shows the newest price, candles or line, volume, TVL, balance, liquidity, depth and curve state without waiting for the candle, volume, stats or snapshot workers. Transactions remain the canonical event list. This covers all chart tabs on launch, curve and pool pages and the corresponding current headline figures and list rows. Historical backfill, late oracle pricing and reorg repair remain authoritative worker responsibilities.

"Realtime" means that a committed event causes an SSE announcement and a bounded refetch of the affected resource. The chart response must include the latest committed raw trade or current chain state; it must not merely refetch a stale rollup. Target: a visible tab updates within two seconds of an SSE event when DB and RPC respond normally. No claim of subsecond chain-to-browser latency: provider delivery time is outside this target.

## Findings in the current code

- Fast lane applies official curve/V3/V4 trades and announces `trade.created` after commit. It watches launch venues only. Other verified V3/V4 pools and V2 pools are ingested by Envio. Fast lane does not yet watch liquidity-change logs.
- Price candle and line styles share `OfficialChart` candle data. It refetches on `launch.changed` or `pool.changed`, but not direct `trade.created`; cached quote candles omit dirty buckets, and USD/pool candles can serve stale rows.
- Volume charts refetch on changed events. Their endpoints read materialized volume buckets, so dirty current minutes are stale until workers finish.
- TVL history reads snapshots. Pool history currently reads snapshots only for V4 even though the snapshot capture loop accepts V2/V3. The latest point is therefore delayed or absent.
- Liquidity/depth/curve components refetch on current SSE events and read chain state on demand. Pool liquidity responses have a 60 s memo; invalidation occurs on `pool.changed`. Swap events are insufficient to detect liquidity adds/removes.
- The launch list's official volume and launch stats follow worker-maintained scores. They have separate freshness rules; they must not be presented as current before their underlying current-bucket overlay is available.

## Chosen approach

Use the committed raw event tables as the live source for chart buckets, and pinned chain reads as the live source for TVL, balances, liquidity and depth. The API overlays only dirty buckets in the requested chart window (including the open bucket) on top of clean materialized history. It recomputes those buckets from raw rows with the same official-venue, priced-side and oracle rules as the workers. This avoids per-trade writes to every interval at chain throughput. A bounded maximum prevents one chart request from rebuilding a long backlog; excess buckets remain gaps and `complete=false` rather than silently showing stale data.

The API returns the same newest-first candle schema and oldest-first history schema. Any new freshness metadata is additive (`asOfBlock`, `asOfTime`, `live`, `complete`) and the UI preserves the current zoom/range when merging a response. A missing verified USD price, unknown decimals, incomplete pool coverage or failed pinned RPC read remains `null`/unavailable, never `$0` or an estimated chart point.

### Price candles and line

After `trade.created`, the launch chart reloads its selected quote/USD/venue range. After `pool.changed`, the pool chart reloads. For each affected bucket, derive exact OHLC in block/log order from committed trades; clean older buckets come from the existing candle tables. Quote and USD share the same trade ordering. USD values use the historical verified oracle round at or before the trade and reject stale/future rounds; any unpriced trade leaves an explicit gap. Pool OHLC uses `sqrt_price_x96` and applies token direction only in the response. Reorg and late trades re-dirty affected buckets and trigger a refetch; a removed last trade removes the candle.

### Volume charts and 24h/30d figures

For each visible dirty bucket, compute USD volume from committed raw trades, then combine with clean rollups. The current bucket is always checked even when the dirty trigger has already been cleared. Pool charts use their selected priced side. Launch all-pools volume sums official venues plus nonofficial verified pools once; curve pages count their scoped venue. Rolling 24h and 30d values use hourly complete buckets plus direct trades at both window edges and in dirty/current minutes, with no double count. The launch list score may be stored with a fresh `asOf` and updated asynchronously, but the visible row/detail must use the live overlay or mark its score as older than the latest trade.

### TVL, balance, liquidity, depth and curve

For a touched pool, read balances/reserves and current price at one chain block at or after the event block, then value TVL with a verified USD feed. Coalesce reads per pool for one second and share the result between summary, history endpoint and liquidity/depth responses. The latest history bucket uses this current reading; prior buckets keep their snapshots. Launch TVL sums current readings for all eligible holding pools, with `null` if a required pool cannot be valued. Pool history supports V4/V3/V2 snapshots. A curve's current state comes from its existing pinned depth read; there is no curve TVL history tab. Pool liquidity and depth use the same pinned tick read and invalidate on pool state changes. No historical liquidity/depth series is added.

Fast lane must also observe state changes without a swap: V4 `ModifyLiquidity`; V3 `Mint`/`Burn`; V2 `Mint`/`Burn`/`Sync`; curve lifecycle/reserve changes if they can occur without a trade. Those logs create a deduplicated pool/curve state notification after commit; the repair sweep revisits the same block range and reorg removal invalidates the same resource. Because the current fast lane watches launch venues, its watch set must include verified pool catalog entries for any pool shown in the app. Unknown/unverified pools never enter the UI or the live set. Envio remains the durable discovery and repair source.

### Browser delivery and caches

Use the existing Postgres notification → API SSE → DOM event path. `trade.created` directly refreshes launch price, volume and curve state; `pool.changed` refreshes pool price/volume/TVL/liquidity/depth and a token page that includes the pool. Oracle repricing and worker repairs announce the affected resource after their new rows commit. Rate-limit fetches to one per second per visible resource, coalesce concurrent reads and refetch once when a hidden tab becomes visible or SSE reconnects. Invalidate API memos on the event before clients refetch. A response with a lower `asOfBlock` cannot overwrite a newer point already displayed.

## Delivery slices

1. Launch and pool price overlay plus direct trade event subscription; preserve line/candle selection and zoom.
2. Volume/history overlay and current 24h/30d figure freshness; remove cache races.
3. Latest TVL/balance overlay from pinned RPC, including V2/V3 snapshots and token all-pools aggregation.
4. Pool/curve state event coverage for liquidity/depth and all verified pools; reorg repair and metrics.
5. End-to-end browser checks for each tab and source, with measured event-to-visible latency and worker-stopped scenario.

## Acceptance and risks

- A committed swap updates price candle and line, volume bar, 24h figure, TVL endpoint, balance and relevant pool/curve views through SSE, without running the candle/volume/snapshot workers.
- A liquidity add/remove without a swap updates pool balances, TVL, liquidity and depth.
- Late trade, duplicate delivery, oracle backfill and reorg produce the same final chart as a full rebuild.
- Unpriced/unknown states remain visibly unavailable; prior priced points keep their original timestamps.
- The bounded overlay protects the DB from a large historical backlog; the UI says history is incomplete until workers catch up.
- The fast lane currently omits general pool swaps and liquidity changes. Extending log subscriptions and repair increases RPC traffic; measure queue latency and use bounded batching before widening the watch set.
