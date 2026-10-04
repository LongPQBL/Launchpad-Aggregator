import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { findRoundAtOrBefore, upsertPriceRounds } from './priceRounds.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const feed = '0xfeedround0000000000000000000000000f001';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE feed_address = $1', [feed]);
  await pool.end();
});

describe('priceRounds', () => {
  it('inserts rounds and finds the newest one at or before an exact position', async () => {
    const inserted = await upsertPriceRounds(pool, 4663, feed, [
      { roundId: 1n, answerRaw: 100_000_000n, decimals: 8, startedAt: 1000, updatedAt: 1000, blockNumber: 100n, logIndex: 1 },
      { roundId: 2n, answerRaw: 200_000_000n, decimals: 8, startedAt: 2000, updatedAt: 2000, blockNumber: 200n, logIndex: 1 },
      { roundId: 3n, answerRaw: 300_000_000n, decimals: 8, startedAt: 3000, updatedAt: 3000, blockNumber: 300n, logIndex: 1 },
    ]);
    expect(inserted).toBe(3);

    expect((await findRoundAtOrBefore(pool, 4663, feed, 250n, 0))?.answerRaw).toBe(200_000_000n);
    expect((await findRoundAtOrBefore(pool, 4663, feed, 200n, 1))?.answerRaw).toBe(200_000_000n);
    expect(await findRoundAtOrBefore(pool, 4663, feed, 50n, 0)).toBeNull();
  });

  it('resolves a same-block tie by log index, not by insertion order', async () => {
    await upsertPriceRounds(pool, 4663, feed, [
      { roundId: 10n, answerRaw: 400_000_000n, decimals: 8, startedAt: 4000, updatedAt: 4000, blockNumber: 400n, logIndex: 5 },
      { roundId: 11n, answerRaw: 500_000_000n, decimals: 8, startedAt: 4001, updatedAt: 4001, blockNumber: 400n, logIndex: 2 },
    ]);
    expect((await findRoundAtOrBefore(pool, 4663, feed, 400n, 5))?.answerRaw).toBe(400_000_000n);
    expect((await findRoundAtOrBefore(pool, 4663, feed, 400n, 3))?.answerRaw).toBe(500_000_000n);
  });

  it('is idempotent on re-insert of the same rounds', async () => {
    const second = await upsertPriceRounds(pool, 4663, feed, [
      { roundId: 1n, answerRaw: 100_000_000n, decimals: 8, startedAt: 1000, updatedAt: 1000, blockNumber: 100n, logIndex: 1 },
    ]);
    expect(second).toBe(0);
  });
});
