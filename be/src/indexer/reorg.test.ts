import { describe, expect, it } from 'vitest';
import type { Hash } from 'viem';
import { reconcileCanonicalHead, type ReorgDeps } from './reorg.js';

const oldHash = `0x${'1'.repeat(64)}` as Hash;
const newHash = `0x${'2'.repeat(64)}` as Hash;

describe('canonical head reconciliation', () => {
  it('retracts old trades from the first replaced block and replays to safe head', async () => {
    const trades = new Map<number, string>([[108, 'old-108'], [109, 'old-109'], [110, 'old-110']]);
    const stored = [108n, 109n, 110n].map((number) => ({ number, hash: oldHash }));
    const retracted: bigint[] = [];
    const deps: ReorgDeps = {
      reorgWindow: 8n,
      getStoredBlocks: async () => stored,
      getCanonicalBlockHash: async (_chainId, number) => number >= 108n ? newHash : oldHash,
      retractBlocks: async (_chainId, from) => {
        retracted.push(from);
        for (const number of [...trades.keys()]) if (BigInt(number) >= from) trades.delete(number);
      },
      scanToSafeHead: async (_chainId, head) => {
        for (let number = 108n; number <= head; number++) trades.set(Number(number), `new-${number}`);
      },
    };
    const report = await reconcileCanonicalHead(4663, 110n, deps);
    expect(report.reorgFromBlock).toBe(108n);
    expect(retracted).toEqual([108n]);
    expect([...trades.values()]).toEqual(['new-108', 'new-109', 'new-110']);
  });

  it('does not replay when stored block hashes still match', async () => {
    let retractions = 0;
    const deps: ReorgDeps = {
      reorgWindow: 8n,
      getStoredBlocks: async () => [{ number: 110n, hash: oldHash }],
      getCanonicalBlockHash: async () => oldHash,
      retractBlocks: async () => { retractions++; },
      scanToSafeHead: async () => { throw new Error('should not scan'); },
    };
    const report = await reconcileCanonicalHead(4663, 110n, deps);
    expect(report.reorgFromBlock).toBeNull();
    expect(retractions).toBe(0);
  });
});
