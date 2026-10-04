# Claude Code Handoff

Read this file first when continuing the project. It summarizes decisions from the planning conversation and the current code state. The user is working alone and prefers that you inspect the repo and continue from the existing plan instead of repeating settled questions.

## Product goal

Build a web app that aggregates token launches from multiple launchpads. The app indexes launches; it does not create tokens. It should let users discover a token, see which launchpad and chain it came from, follow its lifecycle, inspect official trades/chart/volume, and eventually trade directly in the app.

The long-term direction is to cover the union of chains supported by the selected launchpads. For example, if launchpad A supports X/Y and B supports Y/Z, support X/Y/Z while preserving the source launchpad for every token. Do not decide to support every chain in the ecosystem or choose obscure chains only for novelty. Pick integrations based on usable and verifiable data, launch activity, user demand, chain/provider reliability, and implementation cost.

## Decisions already made

- The user is a solo developer. Work directly on `main`; do not create a worktree or split work across agents unless the user changes this preference.
- Start with Pons on Robinhood Chain (`chainId=4663`) because its launch/factory and official trading history have been investigated and implemented first. This is a proving slice, not the final aggregator scope.
- A launchpad/protocol adapter belongs to each venue/protocol version; chain RPC/indexing configuration is a separate concern. One launchpad may need more than one adapter/version, and one chain may host multiple launchpads.
- Aggregate launches from every selected launchpad/chain and keep `platform`/protocol version visible to users.
- Pons V1's protocol-designated venue is its V3 pool. Pons V2's protocol-designated venue is its bonding curve until sweep and then its verified V4 pool. Preserve that designation so protocol-specific launch metrics can be identified accurately.
- Corrected 2026-10-04: the earlier decision to exclude “Pools khác” was wrong and is revoked. The product includes a `Pools` section like Uniswap's with other indexed pools, their swaps, and per-pool USD metrics. Design pool discovery/ingestion/UI as its own work unit and use Envio for new indexing. Share the verified quote/USD oracle registry and historical price rounds with launch metrics. Keep protocol-designated venue volume and all-indexed-pools token volume distinct and clearly labeled; do not double-count a swap.
- Join curve and official V4 trade history across lifecycle transitions. Preserve exact `(blockNumber, logIndex)` ordering, quote-asset denomination, raw integer amounts, provenance, reorg recovery, and source coverage. Do not fabricate candles or volume during a no-trade gap.
- Include actual executed curve buybacks and hook-initiated V4 swaps in official volume exactly once, with a protocol activity label. Fee transfers, refunds, vault locks, notices, and unexecuted buybacks are not extra trades.
- The home/list page should use official 24h volume. A launch detail/chart should reflect its official venue history and show when data is incomplete. Label the source (for example, “pons”); do not imply an official partnership.
- Light UI with a blue accent is preferred (changed 2026-10-01, reversing an earlier "Dark UI" decision — inspired by gol.network's palette, with Uniswap's Launches/token-detail layout patterns for the table and detail page structure).
- Web app: Next.js, React, TypeScript, Tailwind, shadcn/ui, Lightweight Charts. Backend: Node.js >=24, TypeScript, Fastify, viem, PostgreSQL, Drizzle. Tests: Vitest, PostgreSQL integration tests, later Playwright. Docker Compose is optional for local PostgreSQL. Redis/Kafka are not currently needed. CI is in scope; CD/deployment is deferred until hosting and credentials are chosen.
- Run locally and keep the API honest: null means unavailable/incomplete, never silently convert missing data to zero. The app must distinguish unavailable history from a real zero.
- Frontend copy should be English (changed 2026-10-01, reversing an earlier "Vietnamese" decision). Code identifiers, tests, comments, API fields, and filenames should be English. Docs written for the solo developer (this file, README.md) may stay Vietnamese unless the user says otherwise.
- Production DB host: Supabase (decided 2026-10-04). Compared against DigitalOcean Managed Postgres and AWS RDS using the real `launchpad` DB (measured 9.63GB — `raw_logs` 5.5GB is frozen legacy data from the pre-Envio RPC indexer, not a growth driver; `trades` 3.5GB is the actual growth driver, currently only backfilled to block ~34M of a ~77-78M target). At small/medium scale (~100GB, 8GB RAM) DigitalOcean was cheapest; at large scale (~5TB, 16GB RAM) AWS RDS was cheapest (~$819/mo) with Supabase close behind (~$874/mo) and DigitalOcean well behind (~$1,220/mo, its Standard tier isn't built for multi-TB). User chose Supabase for simplicity over RDS's lower price at large scale — explicit tradeoff, not a data-driven "cheapest" pick. This decision covers the `be/` `launchpad` DB (the one the API/FE reads); Envio's own internal indexing DB (~25-30GB, not customer-facing) was not part of this comparison and can be hosted separately/cheaper.

## Future trading direction (not implemented/approved in current spec)

The user's eventual product direction includes buying/selling directly in the app and charging a platform fee or another sustainable mechanism. For a future trading UI, the user's preference is to disable the Buy button when the connected wallet lacks sufficient funds on the selected chain; do not replace it with a deposit prompt. Cross-chain transfer/bridge should be a separate app feature. Keep simulated/test trading clearly separate from real on-chain execution. Before implementing real trading, research competitor fee/routing behavior and write a separate design covering wallet custody/signing, chain-native routing, fee disclosure, slippage, transaction simulation, failures, security, and compliance. Do not add wallet or trading functionality while completing the current read-only launchpad plan.

## Current implementation state (as of 2026-09-29)

The repository is on `main`. The latest local commits are:

- `34f5bd0` decode Pons V2 lifecycle evidence
- `1f28715` persist reorg-safe Pons lifecycle
- `79ab3db` verify graduation and official pool on chain
- `53e93e6` backfill official Pons V4 swaps
- `d7e21f4` expose lifecycle/coverage/volume/candles API
- `04f78db` record fixture/RPC audit
- `3800d25` fix stale-price handling after V4 trades

These commits were made locally; check the Git remote and current branch state before pushing. Do not rewrite history or deploy.

Implemented in `be/`:

- Pons V1 and V2 launch adapters and official venue trade decoders.
- Pons V2 lifecycle transitions (`Trading → Swept → Graduated/Rescued`) stored with raw-log provenance and reorg-safe projection.
- V4 venue accepted only after matching `PoolGraduated` with `PoolManager.Initialize` in the same transaction/block and verifying pool ID/key/hook/manager.
- Durable per-pool V4 swap sources starting at each pool's Initialize block.
- Official trade pages, 24h official quote volume, phase reconciliation, lifecycle/source coverage, bounded read-time candle pages, and OpenAPI.
- Current candle API omits buckets containing unpriced trades and returns completeness. It does not synthesize candles during no-trade intervals.
- Price API exposes whether the last V2 price is stale during a non-trading transition period.
- PostgreSQL migrations through `0008` have been generated. Development DB was migrated during the previous session.

Not implemented: wallet connection, live trading, bridging, platform fees, other launchpads, other chains, full historical backfill, archive-state curve price reconstruction, and production deployment. (This section predates the `fe/` app: a Next.js frontend with its own test/e2e suite now exists — see README.md's "Chạy FE" section — but has not been re-audited here; do not assume this whole section is current without checking `git log` and README.md first.)

## Verified facts and data limitations

- Fixture: `be/tests/fixtures/pons-v2-graduated.json`, token `0xc9e9ab90654f82893d7fd18b62f694992e8cef29`.
- A bounded read-only RPC audit confirmed the launch, curve buy, sweep, Initialize, graduation, and V4 Swap log receipts (exact address, topics, data, block hash, and log index). The V4 sample swap at block `27828165`, log `108`, has raw quote amount `5620497268881825819` and decoded price `0.000000152480063034` quote token per token.
- At the prior audit safe head `75532920`, the sample token's Pons phase read returned `2`. The public Robinhood RPC rejected historical `eth_call` at the sampled earlier blocks, so old phase/reserve state and full historical curve prices remain unverified.
- The local development DB was far behind the observed safe head. After one 100-block bounded indexer cycle, cursors were: `pons-v2=27134043`, `pons-v2-lifecycle=26841946`; observed safe head was `75532920`. Other Pons sources were also behind. `source_gaps` was empty for that audit, but the cursor distance itself means historical coverage is incomplete.
- The indexer currently uses bounded HTTP RPC scans and durable PostgreSQL cursors. Realtime latency has not been measured, and a WebSocket wake-up path is not yet implemented. Preserve HTTP backfill/checkpoints as the correctness path if adding WebSocket notifications later.
- 2026-09-30 live operation: the public Robinhood RPC started returning Cloudflare 403 even for `eth_blockNumber`. The indexer was restarted with a private Validation Cloud URL supplied by the user through `RH_HTTP_RPC_URL`, plus `INDEXER_SHARED_RPC_LOG_RANGE=2000`; the URL/key is intentionally absent from the repository. The current 50,000-block/cycle trial writes to `/private/tmp/indexer-validation-50k-20260930.log`. `eth_blockNumber`, `eth_call`, receipt and `eth_getLogs` succeeded on that endpoint, and factory cursors resumed advancing. The provider rejected a 10,000-block `eth_getLogs` request with a 2,000-range limit. `scan.ts` now redacts RPC URLs before errors reach logs or `source_gaps`.
- A 500,000-block/cycle trial let the dense `pons-v1-active` factory hold the cycle for several minutes; 50,000 blocks/cycle lets lifecycle/trade move sooner but a full cycle with V4 still takes roughly 16–25 minutes. A measured 228,585-block `pons-v1-active` interval contained 6,345 launches; each V1 launch currently triggers four metadata calls plus one graduation-state call. Historical V1-active trade queries at blocks 9,731,762–9,733,761 needed only 236 of 83,680 known pool addresses; filtering by venue birth block reduced 20 RPC requests/9.79s to 1 request/2.23s with the same 326 logs in a read-only probe. A new parallel-window design and plan are in `docs/superpowers/specs/2026-09-30-parallel-indexer-design.md` and `docs/superpowers/plans/2026-09-30-parallel-indexer.md`. Preserve checkpoint/reorg guarantees and measure provider quotas before raising concurrency.
- Do not claim complete Robinhood history or launch counts from one fixture or an empty gap table. API coverage should stay incomplete until each relevant source reaches the required safe head and phase/price validation succeeds.
- 2026-09-30 (continued): Tasks 1-6 of `docs/superpowers/plans/2026-09-30-parallel-indexer.md` are complete (ledger: `.superpowers/sdd/2026-09-30-parallel-indexer/progress.md`) — bounded parallel job-queue scheduler, near-head provisional lane so new launches surface without waiting on historical backfill, per-launch (not global) API coverage for volume/price/candles, and reorg fencing (`repository.invalidateJobsFrom`) for the job-queue path. Selectable via `INDEXER_SCHEDULER=jobs`; the old sequential `runOnce()` loop remains the default and the rollback path (unset the env var and restart) — see README.md's "Bộ lập lịch song song (job-queue) và rollback" section.
- 2026-09-30 live cutover: with the user's explicit go-ahead, the live `launchpad` DB was migrated (0010, additive: new `scan_jobs` table), seeded via `db:seed-certified-coverage`, and the running indexer switched from the sequential runner to `INDEXER_SCHEDULER=jobs`. First attempt crashed the process after ~3.5 min (an uncaught "could not resize shared memory segment... No space left on device" during a venue-snapshot query) and left `pons-v1-active-trades` deterministically failing every window ("bind message has N parameter formats but 0 parameters") — rolled back to the sequential runner immediately, zero data loss (everything is DB-persisted). Root-caused and fixed: jobs-mode had no top-level crash-resilience wrap (unlike the sequential loop's per-cycle try/catch — now added), and PostgreSQL's real 65,535-bind-parameter protocol limit was being hit by a single multi-row INSERT for a high-volume trade window (`be/src/db/chunk.ts` now chunks all bulk inserts in `persistBatchInTransaction`). Re-verified live: `pons-v1-active-trades` advanced cleanly, the same shared-memory error recurred twice more but the process now survives it, and a monitoring window showed 34/34 jobs completing with zero failures. **The live indexer is now running `INDEXER_SCHEDULER=jobs`, not the sequential runner** — check `ps aux | grep runFactoryIndexer` and its env before assuming which mode is active. Task 7 (throughput/ETA reporting) is not yet done.
- 2026-10-04 user direction: new indexing work should target Envio, not `runFactoryIndexer`; the user plans to remove the old RPC indexer. The optional Pons metadata retry worker is wired only to Envio's real-table sync loop and one-shot command. This direction does not itself confirm that the old live process has stopped; inspect running processes before changing live operations.
- 2026-10-04 old RPC-scan indexer removed: confirmed no `runFactoryIndexer`/sync process was running (`ps aux`), then deleted `be/src/cli/runFactoryIndexer.ts`, `indexer.ts`, `indexerStatus.ts`, `benchmarkParallel.ts`, `benchmarkParallelTrades.ts`, `seedCertifiedCoverage.ts`, `backfillTraderAddress.ts` (one-off, already applied), `auditSources.ts`; `be/src/db/repository.ts` + its integration test; `be/src/db/chunk.ts` + test; and every `be/src/indexer/*` module except `concurrency.ts`, `blockData.ts`, `blockDataBatch.ts` (still used by the shared Pons v1/v2 adapters) and `v4PoolWhitelist.ts` (still used by `exportV4PoolWhitelist.ts` to regenerate Envio's pool-whitelist file). Confirmed via `tsc --noEmit`, full unit suite, and lint that nothing else referenced the removed modules. Removed the now-dead `dev:indexer`/`indexer:status`/`db:seed-certified-coverage`/`audit:sources` npm scripts from `be/package.json`, and the matching run/rollback instructions from README.md (the job-queue-vs-sequential rollback path no longer exists — Envio is the only indexing path now). Did not touch any DB schema/tables (`scan_jobs`, `sources`, etc.) — this was a source-code-only cleanup; dropping the now-orphaned `scan_jobs` table, if wanted, is a separate migration decision.

## Roadmap in order

### 1. Finish the Pons read-only product slice

Continue from `docs/superpowers/plans/2026-09-28-pons-frontend-implementation.md` for the original Pons launch flow. The UI must show incomplete coverage honestly. The old plan's ban on “Pools khác” is revoked; design and implement the `Pools` section in a separate work unit. Do not infer that the original Pons launch implementation already indexes those other pools.

Before calling this slice production-ready, run a measured bounded backfill, finish or explicitly document history limitations, test API responses against verified real launches, and report realtime lag/provider limits. Historical state access may require an archive-capable RPC provider; first evaluate free/local options and estimate load/cost, then ask the user only if a paid provider is materially necessary.

### 2. Stabilize the adapter/chain seams

After the Pons UI works end-to-end, review whether source coverage and metric completeness can be calculated per token/relevant source instead of the current conservative global Pons coverage. Add indexes/materialized candles only if measured query latency requires them. Keep migrations additive and preserve user data. Add explicit source metadata and chain registry/config without scattering chain IDs or venue logic.

Design and add the `Pools` section for other verified pools. Index each pool and its swaps through Envio, record both token legs, and use the shared quote/USD price history for per-pool volume and transactions. Define pool discovery and all-pools token metrics in a dedicated spec before implementation; keep protocol-designated launch venue metrics separately labeled.

### 3. Research and add launchpads incrementally

The initial candidate list from the user's project: Pool.xyz, Long, Bankr, Noxa, Pons, Bow, Varo, and letscash.fun/Uniswap launch sources. Do not assume every name has a public API or supports every chain. Research each candidate's official docs/contracts/API/indexing path, launch event/history pagination, trade venue lifecycle, supported chains, rate limits, and terms; test representative live data before recommending it. Integrate one complete launchpad/protocol at a time, starting with the easiest reliable data source and meaningful activity. Build adapters per launchpad protocol/version and chain configs independently. Support the union of chains from chosen platforms; never silently omit source chain coverage.

### 4. Design real trading and monetization separately

Only after read-only launch and venue data are reliable, research how comparable aggregators route transactions and collect platform fees. Produce a separate spec and tests for wallet signing, swap route selection, fees, chain balance/gas eligibility, slippage, transaction state, errors, and security. Keep bridge/transfer between chains a separate feature. User preference: insufficient funds on the selected chain disables Buy without replacing the UI with a deposit prompt.

### 5. Later operationalization

Measure indexer throughput and realtime delay, choose archive/RPC providers based on evidence, load-test DB/API, establish monitoring/backups, choose hosting/secrets, then write a deployment/CD plan. No deployment in the current local-first milestone.

## Source documents

Read these before changing architecture or resuming a plan:

- Product/data model: `docs/superpowers/specs/2026-09-28-pons-readonly-design.md`
- V2 lifecycle/V4 behavior: `docs/superpowers/specs/2026-09-29-pons-v2-lifecycle-design.md`
- Backend plan: `docs/superpowers/plans/2026-09-28-pons-backend-implementation.md`
- V2 lifecycle implementation plan: `docs/superpowers/plans/2026-09-29-pons-v2-lifecycle.md`
- Volume/buyback plan: `docs/superpowers/plans/2026-09-29-pons-protocol-volume-implementation.md`
- Frontend plan: `docs/superpowers/plans/2026-09-28-pons-frontend-implementation.md`
- Local setup/current audit: `README.md`

## How to resume in Claude Code

Start Claude Code at the repository root. Ask it to read `CLAUDE.md`, inspect `git status`, read the referenced frontend plan and the relevant API/spec sections, then continue the next incomplete roadmap item. The user has already said to code directly on `main` and to write tests. Keep each work unit reviewable, run the appropriate checks, and explain any blocker with evidence. Do not ask again about decisions recorded above. If a new decision would change product scope, platform/chain selection, paid infrastructure, or real-money behavior, summarize the concrete choices and trade-offs before asking.
