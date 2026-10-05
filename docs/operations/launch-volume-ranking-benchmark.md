# Launch volume ranking benchmark

Date: 2026-10-05. Plan: `docs/superpowers/plans/2026-10-05-envio-volume24h-usd-cache-implementation.md`, Task 7.

Run: `DATABASE_URL=<...>_bench npx tsx src/cli/benchmarkLaunchVolumeRanking.ts` in `be/`. It refuses any database whose name does not end in `_bench`. Disposable database `launchpad_bench` on the local Postgres container.

## Data shape

- 160,000 launches, 5,469,964 trades, 43,200 price rounds (30 days, one per minute).
- 5,000 launches active in the last 24h with 36 trades each, plus one launch with 20,000 trades in the window. About 200,000 trades fall in the 24h window, not exactly the 180,000 the plan names.
- Single quote asset, one verified feed, every trade priced.

## Results

| Measure | Result | Gate |
| --- | --- | --- |
| Seed (batched insert) | 1,135.6 s | n/a |
| Backfill to complete, 160k scores | 753.6 s, 320 iterations, 0 failed | n/a |
| First page, warm, p50 / p95 | 2.1 / 6.3 ms | warm p95 < 3 s |
| First page, fresh connection | 73.5 ms | cold < 8 s |
| Later pages (20 walked), p95 | 5.5 ms | n/a |
| Filtered search (chain + name), warm p50 / p95 | 2.7 / 7.9 ms | n/a |
| 8 concurrent first pages, p95 each | 36.1 ms | n/a |
| Invalidation to published score, p50 / p95 (20 samples) | 16.7 / 63.5 ms | p95 ≤ 60 s, measured from a committed trade with price |

## Not measured (plan gates still open)

- "Cold" here is a fresh connection on a warm Postgres buffer cache, not a restarted server with cold caches.
- Regression of Envio new-launch/trade commits and transaction/price reads under the same concurrent load (≤ 10%). The baseline needs the Envio path running, which it is not.
- Worst backlog under sustained trade volume.
- The 60-second target starts after the trade and its price are in the app database. Envio ingestion lag is measured separately and is not included here.
- Production or live-DB behavior. The benchmark ran only on the disposable database.
