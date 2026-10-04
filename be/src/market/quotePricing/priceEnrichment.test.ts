import { describe, expect, it, vi } from 'vitest';
import * as priceJobStore from './priceJobStore.js';
import * as feedDiscovery from './feedDiscovery.js';
import * as feedRegistry from './feedRegistry.js';
import * as roundBackfill from './roundBackfill.js';
import { enrichPricesOnce } from './priceEnrichment.js';

vi.mock('./priceJobStore.js');
vi.mock('./feedDiscovery.js');
vi.mock('./feedRegistry.js');
vi.mock('./roundBackfill.js');

describe('enrichPricesOnce', () => {
  it('resolves a claimed feed-resolution job, persists the feed, and marks the job done', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j1', jobType: 'feed_resolution', quoteAssetAddress: '0xquote', feedAddress: null, rangeStart: null, rangeEnd: null, attempts: 0, leaseId: 'l1' },
    ]);
    vi.mocked(feedDiscovery.discoverAndVerifyFeed).mockResolvedValue({ feedAddress: '0xfeed' as never, aggregatorAddress: '0xagg' as never });
    const report = await enrichPricesOnce({} as never, {} as never, new Date(), vi.fn());
    expect(feedRegistry.upsertQuoteFeed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ verificationStatus: 'verified', feedAddress: '0xfeed' }));
    expect(priceJobStore.finishPriceJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ok: true }, expect.anything());
    expect(report).toEqual({ claimed: 1, done: 1, pending: 0 });
  });

  it('marks a feed-resolution job rejected (not retried) when no trustworthy feed is found, without writing a fabricated quote_usd_feeds row', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j2', jobType: 'feed_resolution', quoteAssetAddress: '0xquote2', feedAddress: null, rangeStart: null, rangeEnd: null, attempts: 0, leaseId: 'l2' },
    ]);
    vi.mocked(feedDiscovery.discoverAndVerifyFeed).mockResolvedValue(null);
    const report = await enrichPricesOnce({} as never, {} as never, new Date(), vi.fn());
    expect(feedRegistry.upsertQuoteFeed).not.toHaveBeenCalled();
    expect(priceJobStore.finishPriceJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ok: false, errorKind: 'rejected', error: expect.any(String) }, expect.anything());
    expect(report).toEqual({ claimed: 1, done: 0, pending: 1 });
  });

  it('runs a round-backfill job and marks it done', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j3', jobType: 'round_backfill', quoteAssetAddress: null, feedAddress: '0xagg', rangeStart: 1000, rangeEnd: 2000, attempts: 0, leaseId: 'l3' },
    ]);
    vi.mocked(roundBackfill.backfillRoundsForFeed).mockResolvedValue(5);
    const report = await enrichPricesOnce({} as never, {} as never, new Date(), vi.fn());
    expect(roundBackfill.backfillRoundsForFeed).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4663, '0xagg', 1000, 2000);
    expect(report.done).toBe(1);
  });

  it('a round-backfill job that throws (transport failure) retries, never permanently fails', async () => {
    vi.mocked(priceJobStore.claimDuePriceJobs).mockResolvedValue([
      { id: 'j4', jobType: 'round_backfill', quoteAssetAddress: null, feedAddress: '0xagg2', rangeStart: 1000, rangeEnd: 2000, attempts: 0, leaseId: 'l4' },
    ]);
    vi.mocked(roundBackfill.backfillRoundsForFeed).mockRejectedValue(new Error('RPC timeout'));
    const report = await enrichPricesOnce({} as never, {} as never, new Date(), vi.fn());
    expect(priceJobStore.finishPriceJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ok: false, errorKind: 'transport', error: 'RPC timeout' }, expect.anything());
    expect(report.pending).toBe(1);
  });
});
