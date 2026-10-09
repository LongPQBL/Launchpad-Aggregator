import type { Pool } from 'pg';
import type { Address } from 'viem';
import { claimDuePriceJobs, enqueueRoundBackfillJob, finishPriceJob } from './priceJobStore.js';
import { discoverAndVerifyFeed, type DiscoveryClient } from './feedDiscovery.js';
import { upsertQuoteFeed } from './feedRegistry.js';
import { backfillRoundsForFeed, type BackfillRpcClient } from './roundBackfill.js';

export async function enrichPricesOnce(
  pool: Pool, client: DiscoveryClient & BackfillRpcClient, chainId: number, now: Date,
  lookupBySymbol: (address: string) => Promise<Address | null>, limit = 10,
): Promise<{ claimed: number; done: number; pending: number }> {
  const claims = await claimDuePriceJobs(pool, now, limit, 300_000, chainId);
  let done = 0;
  let pending = 0;
  for (const job of claims) {
    if (job.jobType === 'feed_resolution') {
      const result = await discoverAndVerifyFeed(client, lookupBySymbol, job.quoteAssetAddress as Address);
      if (result) {
        await upsertQuoteFeed(pool, { chainId, quoteAssetAddress: job.quoteAssetAddress as Address,
          feedAddress: result.feedAddress, aggregatorAddress: result.aggregatorAddress, discoverySource: 'directory', verificationStatus: 'verified', now });
        // Don't make a caller wait for the next rolling-window tick (maintainRollingWindows) —
        // a newly verified feed gets its last-24h history backfilled immediately.
        const nowSeconds = Math.floor(now.getTime() / 1000);
        await enqueueRoundBackfillJob(pool, chainId, result.feedAddress, nowSeconds - 86_400, nowSeconds);
        await finishPriceJob(pool, job, { ok: true }, now);
        done++;
      } else {
        // No quote_usd_feeds row is written here — resolveVerifiedFeed already returns null for an
        // address with no row at all, and this job's own permanent 'failed' status (never re-claimed
        // by claimDuePriceJobs's `status = 'pending'` filter) is what prevents retrying forever into
        // a fabricated match. Writing a sentinel/placeholder row would be exactly the kind of
        // fabricated-looking value this project's conventions reject.
        await finishPriceJob(pool, job, { ok: false, errorKind: 'rejected', error: 'no trustworthy feed found' }, now);
        pending++;
      }
    } else {
      try {
        await backfillRoundsForFeed(client, pool, chainId, job.feedAddress as Address, job.rangeStart!, job.rangeEnd!);
        await finishPriceJob(pool, job, { ok: true }, now);
        done++;
      } catch (error) {
        await finishPriceJob(pool, job, { ok: false, errorKind: 'transport', error: (error as Error).message }, now);
        pending++;
      }
    }
  }
  return { claimed: claims.length, done, pending };
}

// Keeps the rolling 24h volume/trade-valuation window populated even when nothing happens to
// enqueue it otherwise (a quiet feed with no new feed_resolution and no /trades page view). Each
// call enqueues one round_backfill job per verified feed, bucketed to a stable 5-minute window —
// repeated calls within the same bucket dedupe via price_jobs' existing unique index, so this is
// safe to call on every loop tick without piling up jobs. backfillRoundsForFeed's own 24h
// lookback (see roundBackfill.ts) guarantees the predecessor round is captured even on a feed
// quiet enough that no new round falls inside this particular 5-minute slice.
const ROLLING_WINDOW_BUCKET_SECONDS = 300;

export async function maintainRollingWindows(pool: Pool, chainId: number, now: Date): Promise<number> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const bucketEnd = Math.floor(nowSeconds / ROLLING_WINDOW_BUCKET_SECONDS) * ROLLING_WINDOW_BUCKET_SECONDS;
  const bucketStart = bucketEnd - ROLLING_WINDOW_BUCKET_SECONDS;
  const result = await pool.query(
    `SELECT DISTINCT feed_address FROM quote_usd_feeds WHERE chain_id = $1 AND verification_status = 'verified'`,
    [chainId],
  );
  for (const row of result.rows as { feed_address: string }[]) {
    await enqueueRoundBackfillJob(pool, chainId, row.feed_address, bucketStart, bucketEnd);
  }
  return result.rows.length;
}

export function startPriceEnrichmentLoop(run: () => Promise<void>): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve().then(run).catch(() => { /* caller wraps run() in its own try/catch */ }).finally(() => { active = null; });
  };
  const interval = setInterval(tick, 60_000);
  tick();
  return { async stop() { stopped = true; clearInterval(interval); if (active) await active; } };
}
