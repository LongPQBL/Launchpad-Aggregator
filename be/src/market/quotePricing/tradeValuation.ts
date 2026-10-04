import { formatUnits } from 'viem';
import type { Pool } from 'pg';
import { resolveVerifiedFeed } from './feedRegistry.js';
import { findRoundAtOrBefore } from './priceRounds.js';

// Same conservative ceiling as the existing latest-price reader (be/src/market/usdPricing.ts) —
// a round older than this at the TRADE's own timestamp (not "now") is rejected, never fabricated.
const MAX_PRICE_AGE_SECONDS = 24 * 60 * 60;

export type TradeUsdValuation = { status: 'priced'; usdValue: string } | { status: 'pending' } | { status: 'unavailable' };

export interface TradeForValuation {
  timestamp: number; quoteAmountRaw: bigint; quoteAssetDecimals: number; blockNumber: bigint; logIndex: number;
}

export async function valueTradeUsd(pool: Pool, chainId: number, quoteAssetAddress: string, trade: TradeForValuation): Promise<TradeUsdValuation> {
  const feed = await resolveVerifiedFeed(pool, chainId, quoteAssetAddress);
  if (!feed) return { status: 'unavailable' };
  const round = await findRoundAtOrBefore(pool, chainId, feed.feedAddress, trade.blockNumber, trade.logIndex);
  if (!round) return { status: 'pending' };
  const ageSeconds = trade.timestamp - round.updatedAt;
  if (ageSeconds < 0 || ageSeconds > MAX_PRICE_AGE_SECONDS) return { status: 'pending' };
  const quoteAmount = Number(formatUnits(trade.quoteAmountRaw, trade.quoteAssetDecimals));
  const priceUsd = Number(round.answerRaw) / 10 ** round.decimals;
  return { status: 'priced', usdValue: (quoteAmount * priceUsd).toString() };
}
