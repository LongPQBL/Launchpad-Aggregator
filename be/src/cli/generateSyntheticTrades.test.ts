import { describe, expect, it } from 'vitest';
import { buildSyntheticTradeBatch } from './generateSyntheticTrades.js';

describe('buildSyntheticTradeBatch', () => {
  it('builds the requested count of rows with strictly increasing (blockNumber, logIndex) and timestamp', () => {
    const rows = buildSyntheticTradeBatch({ chainId: 4663, tokenAddress: '0xabc', venueId: 'v1', quoteAssetAddress: '0xquote',
      startBlock: 100n, count: 5, startTimestamp: 1_700_000_000 });
    expect(rows).toHaveLength(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].blockNumber > rows[i - 1].blockNumber
        || (rows[i].blockNumber === rows[i - 1].blockNumber && rows[i].logIndex > rows[i - 1].logIndex)).toBe(true);
      expect(rows[i].timestamp).toBeGreaterThanOrEqual(rows[i - 1].timestamp);
    }
  });

  it('gives every row a unique txHash so the (chainId, txHash, logIndex) primary key never collides', () => {
    const rows = buildSyntheticTradeBatch({ chainId: 4663, tokenAddress: '0xabc', venueId: 'v1', quoteAssetAddress: '0xquote',
      startBlock: 100n, count: 1000, startTimestamp: 1_700_000_000 });
    expect(new Set(rows.map((row) => row.txHash)).size).toBe(1000);
  });
});
