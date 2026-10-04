import { describe, expect, it, vi } from 'vitest';
import * as feedRegistry from './feedRegistry.js';
import * as priceRounds from './priceRounds.js';
import { valueTradeUsd } from './tradeValuation.js';

vi.mock('./feedRegistry.js');
vi.mock('./priceRounds.js');

const chainId = 4663;
const quote = '0xquote00000000000000000000000000000f001';
const trade = { timestamp: 2000, quoteAmountRaw: 1_000_000_000_000_000_000n, quoteAssetDecimals: 18, blockNumber: 200n, logIndex: 1 };

describe('valueTradeUsd', () => {
  it('returns unavailable when there is no verified feed for the quote asset', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue(null);
    const result = await valueTradeUsd({} as never, chainId, quote, trade);
    expect(result).toEqual({ status: 'unavailable' });
  });

  it('returns pending when a verified feed exists but no round is backfilled at or before this trade yet', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore).mockResolvedValue(null);
    expect(await valueTradeUsd({} as never, chainId, quote, trade)).toEqual({ status: 'pending' });
  });

  it('returns pending (not a fabricated value) when the found round is older than the 24h freshness ceiling at trade time', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore).mockResolvedValue({ roundId: 1n, answerRaw: 100_000_000n, decimals: 8,
      startedAt: 0, updatedAt: 0, blockNumber: 1n, logIndex: 0 });
    const staleTrade = { ...trade, timestamp: 2000 + 25 * 3600 };
    expect(await valueTradeUsd({} as never, chainId, quote, staleTrade)).toEqual({ status: 'pending' });
  });

  it('prices the trade using the found round, never the latest/current price', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore).mockResolvedValue({ roundId: 1n, answerRaw: 300_000_000_000n, decimals: 8,
      startedAt: 1999, updatedAt: 1999, blockNumber: 199n, logIndex: 0 });
    const result = await valueTradeUsd({} as never, chainId, quote, trade);
    expect(result).toEqual({ status: 'priced', usdValue: '3000' });
  });

  it('two trades with different historical prices value independently, never sharing one price', async () => {
    vi.mocked(feedRegistry.resolveVerifiedFeed).mockResolvedValue({ chainId, quoteAssetAddress: quote as never,
      feedAddress: '0xfeed' as never, aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified' });
    vi.mocked(priceRounds.findRoundAtOrBefore)
      .mockResolvedValueOnce({ roundId: 1n, answerRaw: 100_000_000_000n, decimals: 8, startedAt: 1000, updatedAt: 1000, blockNumber: 100n, logIndex: 0 })
      .mockResolvedValueOnce({ roundId: 2n, answerRaw: 500_000_000_000n, decimals: 8, startedAt: 3000, updatedAt: 3000, blockNumber: 300n, logIndex: 0 });
    const early = await valueTradeUsd({} as never, chainId, quote, { ...trade, timestamp: 1000, blockNumber: 100n });
    const later = await valueTradeUsd({} as never, chainId, quote, { ...trade, timestamp: 3000, blockNumber: 300n });
    expect(early).toEqual({ status: 'priced', usdValue: '1000' });
    expect(later).toEqual({ status: 'priced', usdValue: '5000' });
  });
});
