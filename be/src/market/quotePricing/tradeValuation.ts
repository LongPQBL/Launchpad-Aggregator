import { formatUnits } from 'viem';
import type { Pool } from 'pg';
import { resolveVerifiedFeed } from './feedRegistry.js';
import { findRoundAtOrBefore } from './priceRounds.js';
import { hasCompletedRoundBackfillCovering } from './priceJobStore.js';

// Same conservative ceiling as the existing latest-price reader (be/src/market/usdPricing.ts) —
// a round older than this at the TRADE's own timestamp (not "now") is rejected, never fabricated.
// Exported so roundBackfill.ts can size its lookback window to exactly this: fetching a
// predecessor round older than this would be pointless, since it could never be selected anyway.
export const MAX_PRICE_AGE_SECONDS = 24 * 60 * 60;

export type TradeUsdValuation = { status: 'priced'; usdValue: string } | { status: 'pending' } | { status: 'unavailable' };

export interface TradeForValuation {
  timestamp: number; quoteAmountRaw: bigint; quoteAssetDecimals: number | null; blockNumber: bigint; logIndex: number;
}

export async function valueTradeUsd(pool: Pool, chainId: number, quoteAssetAddress: string, trade: TradeForValuation): Promise<TradeUsdValuation> {
  // A near-realtime-synced launch's quote asset decimals may still be unresolved (core-metadata
  // enrichment pending) — no price_jobs backfill can ever produce this value, so it's unavailable
  // now rather than pending forever.
  if (trade.quoteAssetDecimals === null) return { status: 'unavailable' };
  const feed = await resolveVerifiedFeed(pool, chainId, quoteAssetAddress);
  if (!feed) return { status: 'unavailable' };
  const round = await findRoundAtOrBefore(pool, chainId, feed.feedAddress, trade.blockNumber, trade.logIndex);
  // No round at all, or the best one found is stale: `pending` only means "backfill may still
  // find something fresher" — once a completed round_backfill job's range has already covered
  // this trade's own timestamp (its internal 24h lookback necessarily searched the same window a
  // fresh round would need to be in), there is nothing left to wait for, so it's `unavailable`,
  // not `pending` forever (final review, Important 6).
  if (!round) {
    const covered = await hasCompletedRoundBackfillCovering(pool, chainId, feed.feedAddress, trade.timestamp, trade.timestamp);
    return { status: covered ? 'unavailable' : 'pending' };
  }
  const ageSeconds = trade.timestamp - round.updatedAt;
  if (ageSeconds < 0 || ageSeconds > MAX_PRICE_AGE_SECONDS) {
    const covered = await hasCompletedRoundBackfillCovering(pool, chainId, feed.feedAddress, trade.timestamp, trade.timestamp);
    return { status: covered ? 'unavailable' : 'pending' };
  }
  const quoteAmount = Number(formatUnits(trade.quoteAmountRaw, trade.quoteAssetDecimals));
  const priceUsd = Number(round.answerRaw) / 10 ** round.decimals;
  return { status: 'priced', usdValue: (quoteAmount * priceUsd).toString() };
}
