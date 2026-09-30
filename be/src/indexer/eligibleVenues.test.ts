import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import type { VenueContext } from './venueStore.js';
import { getTradeSourceDefinitions, withVenueAddresses } from './tradeRuntime.js';

const quote = '0x1111111111111111111111111111111111111111' as Address;
const factory = '0x2222222222222222222222222222222222222222' as Address;
const txHash = `0x${'a'.repeat(64)}` as Hash;

function context(index: number, from: bigint, to: bigint | null = null): VenueContext {
  const tokenAddress = `0x${index.toString(16).padStart(40, '0')}` as Address;
  const poolAddress = `0x${(index + 100).toString(16).padStart(40, '0')}` as Address;
  return {
    launch: {
      chainId: 4663, tokenAddress, name: `Token ${index}`, symbol: `T${index}`, tokenDecimals: 18,
      platform: 'pons', protocolVersion: 'v1', sourceId: 'pons-v1-legacy', sourceLogId: `launch-${index}`,
      factoryAddress: factory, deployerAddress: factory, launchBlock: from, launchTxHash: txHash,
      quoteAsset: { address: quote, symbol: 'Q', decimals: 18 }, lifecycleStatus: 'trading',
    },
    venue: {
      id: `venue-${index}`, chainId: 4663, tokenAddress, kind: 'v3_pool', ref: poolAddress,
      sourceId: 'pons-v1-legacy', sourceLogId: `launch-${index}`, effectiveFromBlock: from,
      effectiveFromLogIndex: 2, effectiveToBlock: to, effectiveToLogIndex: to === null ? null : 8, official: true,
    },
  };
}

describe('historical trade address selection', () => {
  const definition = getTradeSourceDefinitions()[0];

  it('includes a pool born in the last block of the requested range', () => {
    const bornAtEnd = context(1, 200n);
    const source = withVenueAddresses(definition, [bornAtEnd], { fromBlock: 100n, toBlock: 200n });
    expect(source.addresses).toEqual([bornAtEnd.venue.ref]);
  });

  it('excludes pools that did not yet exist in the requested range', () => {
    const oldPool = context(1, 99n);
    const futurePool = context(2, 201n);
    const source = withVenueAddresses(definition, [oldPool, futurePool], { fromBlock: 100n, toBlock: 200n });
    expect(source.addresses).toEqual([oldPool.venue.ref]);
  });

  it('excludes a pool that ended before the requested range', () => {
    const ended = context(1, 50n, 99n);
    const source = withVenueAddresses(definition, [ended], { fromBlock: 100n, toBlock: 200n });
    expect(source.addresses).toEqual([]);
  });

  it('retains a pool ending in the first block so logIndex validation can decide', () => {
    const endedInFirstBlock = context(1, 50n, 100n);
    const source = withVenueAddresses(definition, [endedInFirstBlock], { fromBlock: 100n, toBlock: 200n });
    expect(source.addresses).toEqual([endedInFirstBlock.venue.ref]);
  });
});
