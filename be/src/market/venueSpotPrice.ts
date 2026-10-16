import { parseAbi, type Address } from 'viem';
import { poolPriceRational } from '../pools/valuation.js';
import { readVenueAmounts, type TvlReadClient, type VenueAmountInput } from './tvlReserves.js';

const curveReservesAbi = parseAbi(['function quoteReserve() view returns (uint256)', 'function tokenReserve() view returns (uint256)']);

export interface VenueSpotPriceInput extends VenueAmountInput { tokenDecimals: number; quoteDecimals: number }

/**
 * The current price of one token in its quote asset, read from the venue's own state (the curve's reserves, or a pool's
 * sqrtPriceX96) as a rational in raw units like a trade's price. For a launch that has no priced trade yet. Null when the
 * state cannot be read or is empty: never a guessed price.
 */
export async function readVenueSpotPrice(client: TvlReadClient, input: VenueSpotPriceInput): Promise<{ numerator: bigint; denominator: bigint } | null> {
  try {
    if (input.kind === 'curve') {
      const [quoteReserve, tokenReserve] = await Promise.all((['quoteReserve', 'tokenReserve'] as const).map((functionName) =>
        client.readContract({ address: input.ref as Address, abi: curveReservesAbi, functionName, blockNumber: input.blockNumber })));
      if (typeof quoteReserve !== 'bigint' || typeof tokenReserve !== 'bigint' || quoteReserve <= 0n || tokenReserve <= 0n) return null;
      return { numerator: quoteReserve * 10n ** BigInt(input.tokenDecimals), denominator: tokenReserve * 10n ** BigInt(input.quoteDecimals) };
    }
    const amounts = await readVenueAmounts(client, input);
    if (!amounts || amounts.sqrtPriceX96 === null || amounts.tokenIsCurrency0 === null) return null;
    return poolPriceRational(amounts.sqrtPriceX96, input.tokenDecimals, input.quoteDecimals, amounts.tokenIsCurrency0);
  } catch { return null; }
}
