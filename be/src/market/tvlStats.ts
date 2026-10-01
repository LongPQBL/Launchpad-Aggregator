import type { Address } from 'viem';
import { v2FactoryStateAbi } from '../launchpads/pons/v2/abi.js';
import { readUsdPrice, type UsdPriceClient } from './usdPricing.js';
import { readVenueAmounts, type TvlReadClient, type VenueAmountInput, type VenueAmounts } from './tvlReserves.js';
import { calculateTvlUsd } from './tvlValue.js';

export interface TvlFields {
  tvlUsd: string | null;
  tvlBasis: VenueAmounts['basis'] | null;
  tvlBlockNumber: string | null;
  tvlPriceSource: 'chainlink' | null;
  tvlPriceUpdatedAt: number | null;
  tvlUnavailableReason: string | null;
}

export const NULL_TVL: TvlFields = { tvlUsd: null, tvlBasis: null, tvlBlockNumber: null,
  tvlPriceSource: null, tvlPriceUpdatedAt: null, tvlUnavailableReason: 'unavailable' };

export interface CurrentTvlInput {
  chainId: number; token: string; quote: string; tokenDecimals: number; quoteDecimals: number;
  protocolVersion: string; factory: string; lifecycleStatus: string;
  venue: { kind: VenueAmountInput['kind']; ref: string } | null;
  v4PoolFee: number | null; v4TickSpacing: number | null;
}

export async function readCurrentTvl(client: UsdPriceClient & TvlReadClient, input: CurrentTvlInput,
  now: () => number = Date.now): Promise<TvlFields> {
  if (input.chainId !== 4663 || !client.getBlockNumber) return { ...NULL_TVL, tvlUnavailableReason: 'chain_unavailable' };
  try {
    const [blockResult, quoteResult] = await Promise.allSettled([
      client.getBlockNumber(), readUsdPrice(client, input.quote, now),
    ]);
    if (blockResult.status === 'rejected') return { ...NULL_TVL, tvlUnavailableReason: 'chain_unavailable' };
    const blockNumber = blockResult.value;
    if (quoteResult.status === 'rejected' || !quoteResult.value) return { ...NULL_TVL, tvlBlockNumber: blockNumber.toString(),
      tvlUnavailableReason: 'quote_price_unavailable' };
    const quotePrice = quoteResult.value;
    const priced = { tvlPriceSource: quotePrice.source, tvlPriceUpdatedAt: quotePrice.updatedAt,
      tvlBlockNumber: blockNumber.toString() };
    if (input.protocolVersion === 'v2') {
      const record = await client.readContract({ address: input.factory as Address,
        abi: v2FactoryStateAbi, functionName: 'getLaunchedToken', args: [input.token as Address], blockNumber });
      if (!record || typeof record !== 'object' || !('exists' in record) || record.exists !== true
        || !('phase' in record) || !('curve' in record) || typeof record.curve !== 'string') {
        return { ...NULL_TVL, ...priced, tvlUnavailableReason: 'phase_unverified' };
      }
      if (record.phase === 1 || record.phase === 3) return { ...NULL_TVL, ...priced,
        tvlUnavailableReason: 'no_active_venue' };
      if (!input.venue || (record.phase === 0 && (input.venue.kind !== 'curve'
        || input.venue.ref.toLowerCase() !== record.curve.toLowerCase()))
        || (record.phase === 2 && input.venue.kind !== 'v4_pool')) {
        return { ...NULL_TVL, ...priced, tvlUnavailableReason: 'venue_phase_mismatch' };
      }
    }
    if (!input.venue) return { ...NULL_TVL, ...priced, tvlUnavailableReason: 'venue_unavailable' };
    const amounts = await readVenueAmounts(client, { kind: input.venue.kind, ref: input.venue.ref,
      token: input.token, quote: input.quote, blockNumber,
      v4PoolFee: input.v4PoolFee, v4TickSpacing: input.v4TickSpacing });
    if (!amounts) return { ...NULL_TVL, ...priced, tvlUnavailableReason: 'reserve_unavailable' };
    const tvlUsd = calculateTvlUsd(amounts, input.quoteDecimals, input.tokenDecimals, quotePrice.priceUsd);
    if (tvlUsd === null) return { ...NULL_TVL, ...priced, tvlUnavailableReason: 'valuation_unavailable' };
    return { tvlUsd, tvlBasis: amounts.basis, ...priced, tvlUnavailableReason: null };
  } catch { return { ...NULL_TVL, tvlUnavailableReason: 'onchain_read_failed' }; }
}
