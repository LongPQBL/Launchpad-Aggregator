# Envio near realtime delivery

**Date:** 2026-10-05  
**Status:** Design for review; implementation is a separate work unit.

## Goal and measured baseline

New Pons launches and official trades should appear in the existing list and detail UI as soon as Envio has indexed their blocks. A launch keeps the normal row layout when metadata is pending: use its address as the name fallback and show `—` for unavailable values. Historical coverage, official venue rules, and reorg safety remain authoritative.

The current `syncEnvioStagingLoop.ts` waits 900,000 ms after each full V1 → V2 → V4 pass. V1/V2 reread complete raw tables, V4 rereads all swaps matching known Pons pools, and each pass rebuilds the last 500 blocks. Lowering only the sleep interval would multiply work. The API listens for `launchpad_events`, but no production writer currently calls `pg_notify`; the frontend SSE connection can therefore remain open without receiving new launch or trade events.

The October 4 source probe also showed that free HyperSync access can return HTTP 429 and make the Envio indexer pause for roughly 55 seconds. The targets below begin **after an event is committed to Envio's database**. Chain-to-UI time must be measured separately and cannot be guaranteed while the upstream source is throttled.

## Data flow

```text
Robinhood Chain → Envio HyperIndex → Envio raw Postgres
                                   → bounded incremental sync → app Postgres
                                                              → NOTIFY → API SSE → UI refresh
```

Envio HyperIndex remains the sole canonical chain indexer. The app sync reads Envio's persisted raw entities. This work does not restore the removed RPC-scan indexer and does not add a second RPC WebSocket ingest path. A production RPC WebSocket may be evaluated later against the measured chain-to-Envio lag; it is not required to correct the app's 15-minute delay.

## Incremental cursors and scheduling

Add durable app-DB cursors per Envio raw event stream, chain, and lane (`tail` and `history`). Each cursor records the last fully applied block and an intra-block position for bounded keyset pagination. Read a fixed `latest_processed_block` from Envio at the start of a pass; never advance a cursor beyond that committed Envio fence. Query only `(cursor, fence]` in bounded pages using `(blockNumber, logIndex, id)` order and an index that supports the query. Advance a cursor in the same app-DB transaction as the rows it writes. Empty block ranges also advance the block watermark. A crash before commit replays the page; unique chain/log keys and idempotent upserts make replay harmless.

Keep the existing V1 launch → V1 swap, V2 launch → curve/lifecycle, and V2 lifecycle → verified V4 venue → V4 swap dependencies. Advance downstream coverage only through blocks for which the required upstream stream has completed. For V1/V2 events whose launch is missing, persist an unresolved source key and retry it after the launch arrives; skipping the event must never advance coverage irreversibly. When a Pons V4 venue is verified, query that pool's raw swaps from its Initialize block through the current Envio fence before marking its trade coverage complete. The global V4 tail may ignore other pool IDs because they remain in Envio raw tables for the future `Pools` work unit; those pools do not enter a launch's official volume.

The `tail` lane starts near Envio's current processed head, with a 500-block overlap, to surface new activity while the `history` lane resumes from the earliest unsynced Envio block. Existing app rows are retained and deduplicated by their chain/log identity. Historical and tail workers use separate bounded DB connection budgets. The tail lane gets priority; a long history pass or failed metadata read cannot hold it. Run short tail passes continuously with a small interruptible wait (initial target 1 second between passes), and back off with jitter on DB errors. The interval is tunable, but batch duration and lag metrics, rather than the timer alone, determine freshness.

## Immediate launch records and enrichment

Write the launch's chain ID, token address, factory, deployer, quote address, source log position, and known venue as soon as its Envio event is available. Make metadata columns nullable where the event cannot provide a verified value (V1 token name/symbol/decimals; V2 name/symbol and unknown quote metadata). Update domain/API/frontend types and all price/volume calculations to propagate unknown values as `null`, never zero or an invented label. The UI shows the address until a name is available and `—` for unavailable numbers. Existing persisted rows are not rewritten to null.

Move blocking name/symbol/decimals and extended metadata RPC calls out of the ingestion transaction into retryable, bounded enrichment jobs. A transient RPC failure leaves the launch visible with pending fields and cannot prevent later events from syncing. Verified values update the same row, then trigger a launch refresh. Record retry state and next attempt; malformed contracts can terminate a field's retries only after the error has been classified as a contract-level failure. Preserve the current extended-metadata retry worker where it already provides this behavior.

## Reorg repair and coverage

Separate frequent append ingestion from repair of the latest 500 blocks. On a bounded repair schedule and after a detected Envio rollback, compare Envio's current canonical `(chainId, txHash, logIndex, blockHash)` records with Envio-derived app rows in that window. If Envio's processed block falls behind a cursor, rewind the affected cursors to the repair boundary before resuming append ingestion. In one app-DB transaction, remove only stale Envio-derived rows, apply replacements in dependency order, update affected source coverage, and publish change notifications. Preserve metadata on a surviving launch; do not repeatedly refetch it during repair. Rows imported by the old indexer retain their existing provenance and are not deleted merely because Envio has not scanned their range yet.

For API coverage, record each required source's confirmed block as the minimum contiguous block actually applied by its app-sync streams. Keep the observed Envio chain head as the comparison point in `safeHead()`: Envio's observed head alone does not prove trades reached the app DB. The separate tail lane can display known new rows while the history lane's coverage remains incomplete. Do not mark the last 500 blocks final. If Envio or the app sync is behind, keep the existing incomplete-coverage semantics and report the lag rather than presenting a complete zero.

## Notification and UI behavior

After a successful app-DB transaction, publish compact `launch.changed`, `trade.created`, or `coverage.changed` messages on `launchpad_events` with chain ID and token address where applicable. Use `pg_notify` inside the transaction so delivery occurs only after commit; coalesce by token/event type per batch rather than emitting one notification per swap. The API's existing LISTEN bridge forwards these messages over SSE. Reconnect the DB listener after a disconnect, and make the frontend refetch once on SSE reconnection. Add a low-rate refresh while SSE is open so a missed notification cannot leave a tab stale indefinitely; it is a recovery mechanism, not the primary freshness path.

For a new launch, notify when its minimal row commits and again when verified metadata arrives. For trades, notify after the app trade rows commit. Detail transactions and latest price should refresh ahead of slower derived work such as the separately specified 24-hour USD volume cache. This design does not claim that volume rankings update on every trade before that cache is implemented.

## Rollout, measurement, and acceptance

Use additive migrations, with existing data and cursors preserved. Build and validate the incremental path against a disposable Envio/app DB pair before replacing the full-table loop. Compare row counts and canonical log keys across V1 launches/swaps, V2 curve/lifecycle, and verified V4 swaps. Keep the old full pass available as an offline reconciliation command during rollout, not as the frequent live loop. Do not run destructive migration or a trial sync against the user's existing app DB.

Measure four timestamps separately: block timestamp → Envio raw visibility, Envio raw visibility → app row commit, app commit → SSE delivery, and SSE delivery → rendered UI. Since the current raw schema has no commit timestamp, a live probe must observe first raw-row visibility and mark it as a measurement proxy; do not mislabel it as Envio's internal commit time. Under a healthy Envio source and local test load, target p95 ≤ 3 seconds from raw visibility to app commit and p95 ≤ 5 seconds from raw visibility to visible UI; report misses, worst case, and source throttling separately. Alert on tail cursor lag, history backlog, enrichment retries, repair failures, and SSE listener disconnects. Do not assert chain-to-UI realtime until it has been measured with the production provider.

Integration tests must cover restart after partial page failure, empty block ranges, launch-before-metadata, swap-before-venue resolution, history/tail overlap, duplicate events, Envio rollback, reorg replacement and deletion, source coverage, notification only after commit, and missed-notification recovery. A live probe should verify a new launch and transaction reach the normal UI layout, with unknown fields displayed as unavailable and later filled by enrichment.
