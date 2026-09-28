import type { Address } from 'viem';
import type { Venue } from '../domain/types.js';

export interface LogQuery {
  chainId: number;
  kind: 'v3_pool' | 'curve';
  addresses: Address[];
}

export function groupVenueQueries(venues: readonly Venue[], maxAddresses: number): LogQuery[] {
  if (!Number.isInteger(maxAddresses) || maxAddresses < 1) throw new Error('maxAddresses must be a positive integer');
  const groups = new Map<string, LogQuery>();
  for (const venue of venues) {
    if (venue.kind === 'v4_pool') continue;
    const key = `${venue.chainId}:${venue.kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { chainId: venue.chainId, kind: venue.kind, addresses: [] };
      groups.set(key, group);
    }
    const address = venue.ref.toLowerCase() as Address;
    if (!group.addresses.includes(address)) group.addresses.push(address);
  }
  const queries: LogQuery[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.addresses.length; i += maxAddresses) {
      queries.push({ chainId: group.chainId, kind: group.kind, addresses: group.addresses.slice(i, i + maxAddresses) });
    }
  }
  return queries;
}
