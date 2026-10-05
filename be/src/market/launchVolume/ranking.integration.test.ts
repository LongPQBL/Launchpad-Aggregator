import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readVolumeRankingPage, type VolumeRankCursor } from './ranking.js';
import { assertVolumeRankingAvailable, markVolumeBackfillComplete, recordVolumeWorkerHeartbeat, VolumeRankingUnavailableError } from './state.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'ranking-test-src';
const quote = `0x${'be'.repeat(20)}`;
const now = new Date('2026-10-05T12:00:00Z');
const windowEnd = Math.floor(now.getTime() / 1000);
const tokens = [`0x${'a1'.repeat(20)}`, `0x${'a2'.repeat(20)}`, `0x${'a3'.repeat(20)}`, `0x${'a4'.repeat(20)}`, `0x${'a5'.repeat(20)}`];
const names = ['RankTest Big', 'RankTest Small', 'RankTest Empty', 'RankTest Unpriced', 'RankTest Newer Empty'];

interface Seed { index: number; volume: string | null; category: 'positive' | 'zero' | 'null'; block: number; reason?: string }
const seeds: Seed[] = [
  { index: 0, volume: '50', category: 'positive', block: 100 },
  { index: 1, volume: '5', category: 'positive', block: 200 },
  { index: 2, volume: '0', category: 'zero', block: 150 },
  { index: 3, volume: null, category: 'null', block: 120, reason: 'unpriced_trade' },
  { index: 4, volume: '0', category: 'zero', block: 300 },
];

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v1', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'a0'.repeat(20)}`]);
  for (const [index, token] of tokens.entries()) {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
      protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
      quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES ($1, $2, $3, $4, 'RT', 18, 'pons', 'v1', $2, $2, $5, $6, 1, $7, 'WETH', 18, 'trading') ON CONFLICT DO NOTHING`,
    [chainId, token, source, names[index], seeds[index]!.block, `0x${String(index + 1).repeat(64)}`, quote]);
  }
});

beforeEach(async () => {
  await pool.query('DELETE FROM launch_volume24h_usd WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, tokens]);
  for (const seed of seeds) {
    await pool.query(`INSERT INTO launch_volume24h_usd (chain_id, token_address, volume_usd, rank_category, rank_order,
      completeness_reason, computed_at, window_end, next_expiry_at, revision, launch_block, launch_tx_hash, launch_log_index)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, NULL, 1, l.launch_block, l.launch_tx_hash, l.launch_log_index
      FROM launches l WHERE l.chain_id = $1 AND l.token_address = $2`,
    [chainId, tokens[seed.index], seed.volume, seed.category, seed.category === 'positive' ? 0 : seed.category === 'zero' ? 1 : 2,
      seed.reason ?? (seed.category === 'positive' ? 'complete' : seed.category === 'zero' ? 'complete' : 'unpriced_trade'), now, windowEnd]);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM launch_volume24h_usd WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, tokens]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, tokens]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

async function readAll(limit: number, cursor: VolumeRankCursor | null = null, search?: string) {
  return readVolumeRankingPage(pool, { chainId, search, cursor, limit, headBlock: null });
}

describe('readVolumeRankingPage', () => {
  it('orders positive volume descending, then known zero, then null, with recency as the tie-breaker', async () => {
    const page = await readAll(10, null, 'RankTest');
    expect(page.rows.map((row) => row.raw.name)).toEqual([
      'RankTest Big', 'RankTest Small', 'RankTest Newer Empty', 'RankTest Empty', 'RankTest Unpriced',
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('pages by keyset without duplicating or skipping a launch when ranks do not move', async () => {
    const first = await readAll(2, null, 'RankTest');
    expect(first.rows.map((row) => row.raw.name)).toEqual(['RankTest Big', 'RankTest Small']);
    expect(first.nextCursor).not.toBeNull();

    const second = await readAll(2, first.nextCursor, 'RankTest');
    const third = await readAll(2, second.nextCursor, 'RankTest');
    const names = [...first.rows, ...second.rows, ...third.rows].map((row) => row.raw.name);
    expect(names).toEqual(['RankTest Big', 'RankTest Small', 'RankTest Newer Empty', 'RankTest Empty', 'RankTest Unpriced']);
    expect(third.nextCursor).toBeNull();
  });

  it('keeps the score position and freshness on each row', async () => {
    const [row] = (await readAll(1, null, 'RankTest')).rows;
    expect(row).toMatchObject({ volumeUsd: '50', rankCategory: 'positive', windowEnd });
  });

  it('applies filters before ranking, so a filtered page is still globally ranked', async () => {
    const page = await readAll(10, null, 'Empty');
    expect(page.rows.map((row) => row.raw.name)).toEqual(['RankTest Newer Empty', 'RankTest Empty']);
  });
});

describe('assertVolumeRankingAvailable', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM launch_volume24h_state WHERE id = 1');
  });

  it('is unavailable while the initial backfill has never completed', async () => {
    await recordVolumeWorkerHeartbeat(pool, now);
    await expect(assertVolumeRankingAvailable(pool, now)).rejects.toBeInstanceOf(VolumeRankingUnavailableError);
  });

  it('is unavailable when the worker heartbeat is more than two minutes old', async () => {
    await markVolumeBackfillComplete(pool, now);
    await recordVolumeWorkerHeartbeat(pool, new Date(now.getTime() - 121_000));
    await expect(assertVolumeRankingAvailable(pool, now)).rejects.toBeInstanceOf(VolumeRankingUnavailableError);
  });

  it('is available once backfill is complete and the heartbeat is fresh', async () => {
    await markVolumeBackfillComplete(pool, now);
    await recordVolumeWorkerHeartbeat(pool, new Date(now.getTime() - 60_000));
    await expect(assertVolumeRankingAvailable(pool, now)).resolves.toBeUndefined();
  });
});
