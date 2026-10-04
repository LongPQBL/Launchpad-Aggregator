import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { backfillRoundsForFeed } from './roundBackfill.js';
import { findRoundAtOrBefore } from './priceRounds.js';
import { MAX_PRICE_AGE_SECONDS } from './tradeValuation.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
// The address callers key rounds by — this is the PROXY (what quote_usd_feeds.feed_address and
// every read (findRoundAtOrBefore) use), never the aggregator the logs actually live at.
const feedAddress = '0xbackfillfeedaddr0000000000000000000f01';
const aggregatorAddress = '0xbackfillaggregator00000000000000000f99';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [feedAddress]);
  await pool.end();
});

// A real log shape (minimal fields backfillRoundsForFeed actually reads) for one AnswerUpdated event.
function answerUpdatedLog(blockNumber: bigint, logIndex: number, current: bigint, roundId: bigint, updatedAt: bigint) {
  return {
    blockNumber, logIndex,
    data: `0x${updatedAt.toString(16).padStart(64, '0')}` as `0x${string}`,
    topics: [
      '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f' as `0x${string}`, // AnswerUpdated topic0
      `0x${(current < 0n ? (1n << 256n) + current : current).toString(16).padStart(64, '0')}` as `0x${string}`,
      `0x${roundId.toString(16).padStart(64, '0')}` as `0x${string}`,
    ] as const,
  };
}

describe('backfillRoundsForFeed', () => {
  it('resolves the real aggregator via aggregator() on the proxy, queries logs only at the aggregator, and stores rounds under the proxy address (the key every read uses)', async () => {
    const logsByAddress = new Map([[aggregatorAddress, [answerUpdatedLog(500n, 3, 300_000_000n, 7n, 1_790_000_123n)]]]);
    let getLogsCallCount = 0;
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber * 10n }),
      getLogs: async ({ address, event }: { address: string; event: { name: string } }) => {
        getLogsCallCount++;
        // A real RPC node only returns logs for the exact address queried — if this is ever
        // called with the proxy instead of the aggregator, it must find nothing, same as the
        // real chain (the plan's own investigation found 0 AnswerUpdated logs at the proxy).
        if (event.name !== 'AnswerUpdated') throw new Error('must filter by the AnswerUpdated event, not fetch everything');
        return logsByAddress.get(address) ?? [];
      },
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === 'aggregator') {
          if (address !== feedAddress) throw new Error('aggregator() must be called on the proxy address');
          return aggregatorAddress;
        }
        if (functionName === 'decimals') return 8;
        throw new Error(`unexpected ${functionName}`);
      },
    };
    const count = await backfillRoundsForFeed(client as never, pool, chainId, feedAddress as never, 4000, 6000);
    expect(count).toBe(1);
    expect(getLogsCallCount).toBe(1);
    const round = await findRoundAtOrBefore(pool, chainId, feedAddress, 500n, 3);
    expect(round?.roundId).toBe(7n);
    expect(round?.answerRaw).toBe(300_000_000n);
    expect(round?.decimals).toBe(8);
    expect(round?.updatedAt).toBe(1_790_000_123);
    expect(round?.blockNumber).toBe(500n);
    expect(round?.logIndex).toBe(3);
  });

  it('widens the fetch window backward by the freshness ceiling so a predecessor round outside [rangeStart, rangeEnd] is still captured', async () => {
    const predecessorFeed = '0xpredecessorfeed00000000000000000000f02';
    const predecessorAgg = '0xpredecessoragg000000000000000000000f03';
    // getBlock maps blockNumber -> blockNumber*10 seconds. rangeStart=100000 -> block 10000.
    // A predecessor round at block 9000 (900s earlier) is within MAX_PRICE_AGE_SECONDS (86400s)
    // of rangeStart, so it must be captured even though it's before rangeStart itself.
    const rangeStart = 100_000;
    const predecessorBlock = 9000n;
    let earliestFromBlock: bigint | null = null;
    let getLogsCalls = 0;
    const client = {
      getBlockNumber: async () => 20_000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber * 10n }),
      getLogs: async ({ address, fromBlock, toBlock }: { address: string; fromBlock: bigint; toBlock: bigint }) => {
        getLogsCalls++;
        // The requested window spans more than 2,000 blocks here — every chunked call must still
        // respect the real provider's per-call range cap (final review, Important 5).
        expect(toBlock - fromBlock).toBeLessThan(2000n);
        if (earliestFromBlock === null || fromBlock < earliestFromBlock) earliestFromBlock = fromBlock;
        if (address !== predecessorAgg) return [];
        if (predecessorBlock < fromBlock || predecessorBlock > toBlock) return [];
        return [answerUpdatedLog(predecessorBlock, 0, 50_000_000n, 1n, predecessorBlock * 10n)];
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'aggregator') return predecessorAgg;
        if (functionName === 'decimals') return 8;
        throw new Error(`unexpected ${functionName}`);
      },
    };
    try {
      const count = await backfillRoundsForFeed(client as never, pool, chainId, predecessorFeed as never, rangeStart, rangeStart + 1000);
      expect(count).toBe(1);
      expect(getLogsCalls).toBeGreaterThan(1); // the window is wide enough that chunking must have occurred
      // The requested fromBlock must correspond to (rangeStart - MAX_PRICE_AGE_SECONDS), not rangeStart itself.
      expect(Number(earliestFromBlock) * 10).toBeLessThanOrEqual(rangeStart - MAX_PRICE_AGE_SECONDS);
      const round = await findRoundAtOrBefore(pool, chainId, predecessorFeed, predecessorBlock, 0);
      expect(round?.roundId).toBe(1n);
    } finally {
      // In `finally`, not after the assertions — a failed run must not leave a row behind that
      // makes upsertPriceRounds' ON CONFLICT DO NOTHING silently mask the next run's real result
      // (found the hard way: a leftover row from a failed attempt earlier this session).
      await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [predecessorFeed]);
    }
  });

  it('rejects a negative Chainlink answer instead of silently clamping it to zero', async () => {
    const negativeFeed = '0xnegativefeed0000000000000000000000000f9';
    const negativeAgg = '0xnegativeagg0000000000000000000000000f10';
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber * 10n }),
      // current = -1 (two's complement, int256) — a real Chainlink feed must never report this;
      // the decoder will correctly decode -1n, and backfillRoundsForFeed must reject it.
      getLogs: async () => [answerUpdatedLog(500n, 0, -1n, 8n, 1_790_000_123n)],
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'aggregator') return negativeAgg;
        if (functionName === 'decimals') return 8;
        throw new Error(`unexpected ${functionName}`);
      },
    };
    await expect(backfillRoundsForFeed(client as never, pool, chainId, negativeFeed as never, 4000, 6000))
      .rejects.toThrow(/invalid/i);
    expect(await findRoundAtOrBefore(pool, chainId, negativeFeed, 500n, 0)).toBeNull();
  });
});
