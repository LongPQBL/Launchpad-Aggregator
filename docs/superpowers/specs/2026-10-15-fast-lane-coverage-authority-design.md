# WebSocket as the live trade coverage authority

Date: 2026-10-15. Status: design approved in conversation; implementation not started.

## Intent

When the WebSocket fast lane is active, Launches should keep showing and refreshing market metrics from the trades it has written to
the app database. Envio remains responsible for launch and lifecycle discovery, historical backfill, and canonical repair/parity; a
temporary Envio lag must not hide otherwise current trade-derived metrics.

The existing fast lane applies official trade rows through `applyLiveRows`, writes the same `trades` records as Envio, and emits the
same change notifications. The API and stats worker nevertheless gate price, volume, FDV, extrema, and change metrics on every
required Envio source being confirmed through the safe head. This couples live display to the indexer's current position and is the
behavior to change.

## Scope

In scope: official launch trades handled by the existing WebSocket lane (Curve, V3 and V4), their trade-derived metrics and Launches
API coverage status, plus truthful tracking of how far the lane has completely swept.

Still Envio-owned: discovery and metadata for launches, lifecycle transitions, V4 initialization and other pool catalog data; all
historical gaps; canonical backfill and parity/reorg reconciliation. A launch or venue must exist in the app database before the lane
can recognize its trades. Extending the lane to discover new launches or pool metadata is a separate change.

## Design

### Coverage authority

Coverage becomes source-aware. Launch/factory and lifecycle requirements continue to use their Envio watermarks. Official trade-source
requirements may instead be satisfied by the fast lane's **contiguous completed block watermark** when it reaches the same safe head.
For each metric, the API/worker must evaluate the same per-launch venue set and the same safe-head boundary; it must not treat a
WebSocket delivery timestamp or a non-contiguous socket event as proof that all trades through a block were seen.

The lane's existing `fast_lane_state.last_block` is advanced only after a successful sweep over every block in the interval. A
large-gap skip must not advance a watermark that API coverage can trust. Envio source confirmation remains a valid alternative for a
trade stream, so Envio can cover a lane gap once its canonical watermark passes it. If neither source covers the safe head, trade
metrics are marked incomplete; previously computed display values remain available as stale values and are not rewritten to NULL
solely because one source is behind.

### Live writes and backfill

WebSocket events continue to write immediately to `trades`, invalidate/rebuild affected volume and candle buckets, recompute launch
stats, and notify connected clients. Envio inserts remain idempotent by the existing trade key. When Envio later supplies a missing
trade, normal incremental sync fills it and invalidates the affected derived buckets; when it supplies an already-written trade, it
does not duplicate the row or notification. Existing reconcile and parity processes remain responsible for detecting lane rows that
disagree with canonical Envio data.

### API and worker behavior

The launch list, launch detail, metric ranking, stats worker, and volume completeness paths must share the source-aware coverage
predicate so their definition of current data cannot diverge. A lane-covered safe head permits stats computation from the app's
combined `trades` table while Envio catches up. A stale/failed lane falls back to Envio coverage; if both are behind, the API keeps
the latest stored metric values and communicates that coverage is incomplete rather than blanking them. Existing TVL behavior remains
independent because it reads current on-chain balances.

## Failure and recovery

- A failed or disconnected socket does not move the trusted watermark. The periodic HTTP sweep repairs ordinary delivery gaps.
- A sweep error leaves the previous watermark intact. A gap too large for the configured recovery limit also leaves the trusted
  watermark intact, allowing Envio to become the fallback authority.
- Reorg removal/reconciliation invalidates affected trade-derived metrics and updates clients as it does today.
- A lane watermark is chain-wide because its completed sweep filters and applies every currently watched official venue; per-launch
  coverage still checks the launch's required source/venue rows and creation block.
- Metrics may be shown from the latest stored result while incomplete, but are not labeled complete/current unless one source covers
  the safe head. API responses should expose the existing coverage status and the last computed time so clients can distinguish the
  two states without inventing a value.

## Acceptance criteria

1. With Envio behind and the fast lane's contiguous watermark through the safe head, a launch with known metadata has non-null
   trade-derived stats and reports trade coverage as caught up.
2. With the lane behind but Envio through the safe head, behavior matches current complete-data behavior.
3. With both behind, the latest stored metrics remain visible as stale/incomplete; no coverage transition alone clears them.
4. A failed sweep or oversized gap cannot falsely advance fast-lane coverage; after Envio passes the gap, coverage becomes complete.
5. A trade first written by the lane and later seen by Envio appears once; a genuinely missing Envio trade updates the appropriate
   volume/candle/stat results.
6. List, detail, sort/ranking, and worker paths agree on coverage for the same launch and safe head.

## Risks and constraints

- A chain-wide contiguous lane watermark can only certify trade streams that the lane actually subscribes to and sweeps. Adding a new
  official venue kind requires updating both the lane's watched events and the coverage mapping.
- Envio remains necessary for launch/lifecycle correctness and metadata; this design does not make those records arrive over the
  WebSocket.
- Current market stats are stored separately from trade rows. The implementation must avoid erasing their last good values on a
  transient coverage lapse while still invalidating/recomputing them after actual trade corrections.
- Existing workspace changes are present in the API, coverage, Envio sync, and fast-lane files. Implementation must preserve and
  review those changes rather than reverting unrelated work.

## Verification plan

Add regression coverage for both source alternatives, stale-value retention, failed/oversized sweeps, and the Envio backfill path; run
the relevant API/coverage/fast-lane integration suites and TypeScript checks. On the dev database, compare the fast-lane watermark,
Envio per-stream watermarks, and API results while Envio is intentionally behind, then confirm backfill/parity repairs the same rows.
