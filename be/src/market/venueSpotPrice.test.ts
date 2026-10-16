import { describe, expect, it } from 'vitest';
import { readVenueSpotPrice } from './venueSpotPrice.js';

const token = '0x1111111111111111111111111111111111111111';
const quote = '0x0000000000000000000000000000000000000000';
const curve = '0x2222222222222222222222222222222222222222';
const base = { token, quote, tokenDecimals: 18, quoteDecimals: 18, blockNumber: 100n };

describe('readVenueSpotPrice', () => {
  it('prices a bonding curve from its reserves, the same quote/token ratio its trades are priced with', async () => {
    const client = { readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'quoteReserve' ? 3n * 10n ** 18n : functionName === 'tokenReserve' ? 6n * 10n ** 26n : (() => { throw new Error(functionName); })() };
    const price = await readVenueSpotPrice(client as never, { ...base, kind: 'curve', ref: curve });
    expect(price).toEqual({ numerator: 3n * 10n ** 18n * 10n ** 18n, denominator: 6n * 10n ** 26n * 10n ** 18n });
  });

  it('is unavailable (null) when a curve reserve is zero or cannot be read, never a made-up price', async () => {
    const zero = { readContract: async ({ functionName }: { functionName: string }) => functionName === 'quoteReserve' ? 0n : 1n };
    expect(await readVenueSpotPrice(zero as never, { ...base, kind: 'curve', ref: curve })).toBeNull();
    const failing = { readContract: async () => { throw new Error('execution reverted'); } };
    expect(await readVenueSpotPrice(failing as never, { ...base, kind: 'curve', ref: curve })).toBeNull();
  });
});
