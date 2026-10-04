import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { toEventSelector } from 'viem';
import { backfillRoundsForFeed } from './roundBackfill.js';
import { findRoundAtOrBefore } from './priceRounds.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const aggregator = '0xbackfillaggregator00000000000000000f01';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [aggregator]);
  await pool.end();
});

const answerUpdatedTopic0 = toEventSelector('AnswerUpdated(int256,uint256,uint256)');

function topicFor(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

describe('backfillRoundsForFeed', () => {
  it('decodes real AnswerUpdated logs into rounds with their exact log position and real decimals, and persists them', async () => {
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber * 10n }),
      getLogs: async () => [{
        blockNumber: 500n, logIndex: 3,
        data: `0x${(1_790_000_123n).toString(16).padStart(64, '0')}` as `0x${string}`, // updatedAt (non-indexed)
        topics: [answerUpdatedTopic0, topicFor(300_000_000n), topicFor(7n)] as const, // [topic0, current, roundId]
      }],
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        throw new Error(`unexpected ${functionName}`);
      },
    };
    const count = await backfillRoundsForFeed(client as never, pool, chainId, aggregator as never, 4000, 6000);
    expect(count).toBe(1);
    const round = await findRoundAtOrBefore(pool, chainId, aggregator, 500n, 3);
    expect(round?.roundId).toBe(7n);
    expect(round?.answerRaw).toBe(300_000_000n);
    expect(round?.decimals).toBe(8);
    expect(round?.updatedAt).toBe(1_790_000_123);
    expect(round?.blockNumber).toBe(500n);
    expect(round?.logIndex).toBe(3);
  });

  it('rejects a negative Chainlink answer instead of silently clamping it to zero', async () => {
    const negativeAggregator = '0xnegativeagg0000000000000000000000000f9';
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber * 10n }),
      getLogs: async () => [{
        blockNumber: 500n, logIndex: 0,
        data: `0x${(1_790_000_123n).toString(16).padStart(64, '0')}` as `0x${string}`,
        // current = -1 (two's complement, int256) — a real Chainlink feed must never report this;
        // the decoder will correctly decode -1n, and backfillRoundsForFeed must reject it.
        topics: [answerUpdatedTopic0, `0x${'f'.repeat(64)}` as `0x${string}`, topicFor(8n)] as const,
      }],
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 8;
        throw new Error(`unexpected ${functionName}`);
      },
    };
    await expect(backfillRoundsForFeed(client as never, pool, chainId, negativeAggregator as never, 4000, 6000))
      .rejects.toThrow(/invalid/i);
    expect(await findRoundAtOrBefore(pool, chainId, negativeAggregator, 500n, 0)).toBeNull();
  });
});
