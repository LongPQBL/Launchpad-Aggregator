import type { VenueContext } from './venueStore.js';

export function eligibleVenues(contexts: readonly VenueContext[], fromBlock: bigint, toBlock: bigint): VenueContext[] {
  if (fromBlock > toBlock) throw new Error('Invalid trade block range');
  return contexts.filter(({ venue }) => venue.effectiveFromBlock <= toBlock
    && (venue.effectiveToBlock === null || venue.effectiveToBlock >= fromBlock));
}
