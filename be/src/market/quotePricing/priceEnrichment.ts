import type { Pool } from 'pg';
import type { Address } from 'viem';
import { claimDuePriceJobs, finishPriceJob } from './priceJobStore.js';
import { discoverAndVerifyFeed, type DiscoveryClient } from './feedDiscovery.js';
import { upsertQuoteFeed } from './feedRegistry.js';
import { backfillRoundsForFeed, type BackfillRpcClient } from './roundBackfill.js';

const CHAIN_ID = 4663;

export async function enrichPricesOnce(
  pool: Pool, client: DiscoveryClient & BackfillRpcClient, now: Date,
  lookupBySymbol: (address: string) => Promise<Address | null>, limit = 10,
): Promise<{ claimed: number; done: number; pending: number }> {
  const claims = await claimDuePriceJobs(pool, now, limit, 300_000);
  let done = 0;
  let pending = 0;
  for (const job of claims) {
    if (job.jobType === 'feed_resolution') {
      const result = await discoverAndVerifyFeed(client, lookupBySymbol, job.quoteAssetAddress as Address);
      if (result) {
        await upsertQuoteFeed(pool, { chainId: CHAIN_ID, quoteAssetAddress: job.quoteAssetAddress as Address,
          feedAddress: result.feedAddress, aggregatorAddress: result.aggregatorAddress, discoverySource: 'directory', verificationStatus: 'verified', now });
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
        await backfillRoundsForFeed(client, pool, CHAIN_ID, job.feedAddress as Address, job.rangeStart!, job.rangeEnd!);
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
