import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { backfillRoundHistory, type RoundHistoryClient } from './roundHistoryBackfill.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const proxy = '0x9191919191919191919191919191919191919191' as const;
const aggregator = '0x9292929292929292929292929292929292929292' as const;
const HEAD = 1_000_000n;
const NOW = 1_800_000_000;
// Block n has timestamp NOW - 2 * (HEAD - n); round r (1..10) was updated at NOW - (10 - r) * 3600 and its log sits in the first block of that second.
const tsOfBlock = (block: bigint) => NOW - 2 * Number(HEAD - block);
const roundTime = (round: number) => NOW - (10 - round) * 3600;
const blockOfRound = (round: number) => HEAD - BigInt((10 - round) * 1800);

function client(options: { failRounds?: number[]; missingLogs?: number[]; firstRound?: number } = {}): RoundHistoryClient {
  return {
    async getBlockNumber() { return HEAD; },
    async getBlock({ blockNumber }: { blockNumber: bigint }) { return { timestamp: BigInt(tsOfBlock(blockNumber)) }; },
    async readContract({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address: string }) {
      if (functionName === 'aggregator') return aggregator;
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRound') return 10n;
      if (functionName === 'getRoundData') {
        const round = Number(args![0]);
        if (round < (options.firstRound ?? 1) || options.failRounds?.includes(round)) throw new Error('No data present');
        return [BigInt(round), BigInt(200_000_000 + round * 1_000_000), BigInt(roundTime(round)), BigInt(roundTime(round)), BigInt(round)];
      }
      throw new Error(`${functionName} @ ${address}`);
    },
    async getLogs({ args, fromBlock, toBlock }: { args: { roundId: bigint }; fromBlock: bigint; toBlock: bigint }) {
      const round = Number(args.roundId);
      if (options.missingLogs?.includes(round)) return [];
      const block = blockOfRound(round);
      return block >= fromBlock && block <= toBlock ? [{ blockNumber: block, logIndex: 3 }] : [];
    },
  } as unknown as RoundHistoryClient;
}
const stored = () => pool.query('SELECT round_id, answer_raw, block_number, log_index, updated_at FROM quote_usd_price_rounds WHERE feed_address = $1 ORDER BY round_id::numeric', [proxy]);

beforeAll(async () => { await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [proxy]); });
beforeEach(async () => { await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [proxy]); });
afterAll(async () => { await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [proxy]); await pool.end(); });

describe('backfillRoundHistory', () => {
  it('stores each round with its exact block and log index, back to a day before the requested start', async () => {
    // Needed from round 6's time: rounds back to the one at least 24 h older (round 6 is 4 h before NOW; 24 h earlier is far before round 1).
    const result = await backfillRoundHistory(client(), pool, chainId, proxy, roundTime(6), { concurrency: 3 });
    expect(result.reachedStart).toBe(true);
    const rows = (await stored()).rows;
    expect(rows.map((row) => Number(row.round_id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows[4]).toMatchObject({ round_id: '5', answer_raw: '205000000', block_number: blockOfRound(5).toString(), log_index: 3 });
  });
  it('stops once a round older than the freshness ceiling has been stored', async () => {
    // From NOW the window needs rounds back to NOW - 24 h: the 10-hour-spread test feed has none older, so it stops at the feed start instead.
    const result = await backfillRoundHistory(client({ firstRound: 4 }), pool, chainId, proxy, NOW, { concurrency: 2 });
    expect(result.reachedStart).toBe(true);
    expect((await stored()).rows.map((row) => Number(row.round_id))).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });
  it('is safe to re-run: stored rounds are skipped', async () => {
    await backfillRoundHistory(client(), pool, chainId, proxy, roundTime(6));
    const again = await backfillRoundHistory(client(), pool, chainId, proxy, roundTime(6));
    expect(again.inserted).toBe(0);
    expect(again.alreadyStored).toBe(10);
  });
  it('skips a round whose log cannot be found instead of guessing its position, and keeps going past a failed read', async () => {
    const result = await backfillRoundHistory(client({ missingLogs: [7] }), pool, chainId, proxy, roundTime(6));
    expect(result.unlocated).toBe(1);
    expect((await stored()).rows.map((row) => Number(row.round_id))).not.toContain(7);
    expect((await stored()).rows).toHaveLength(9);
  });
});
