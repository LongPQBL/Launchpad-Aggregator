import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApiStore } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const store = createApiStore(pool);

const chainId = 4663;
const source = 'global-tx-test-src';
const tokenA = `0x${'6a'.repeat(20)}`;
const tokenB = `0x${'6b'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const venueA = 'global-tx-test-venue-a';
const venueB = 'global-tx-test-venue-b';
const hash = (c: string) => `0x${c.repeat(64)}`;
const BASE_BLOCK = 990_000_000;

async function addTrade(venueId: string, token: string, block: number, txChar: string, side: string, timestamp: number) {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'2000000000000000000','1000000000000000000',$9,'CurveBuy','user_trade',$2)`,
  [chainId, token, venueId, block, hash('a'), hash(txChar), timestamp, side, quote]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'6c'.repeat(20)}`]);
  for (const [index, [token, venueId, symbol]] of [[tokenA, venueA, 'GTA'], [tokenB, venueB, 'GTB']].entries()) {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
      protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
      quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES ($1, $2, $3, $4, $5, 18, 'pons', 'v2', $2, $2, $6, $7, 0, $8, 'ETH', 18, 'trading') ON CONFLICT DO NOTHING`,
    [chainId, token, source, `Global Tx ${symbol}`, symbol, BASE_BLOCK - 10 + index, hash(String(index + 1)), quote]);
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1, $2, $3, 'curve', $3, $4, 1, true) ON CONFLICT DO NOTHING`, [venueId, chainId, token, source]);
  }
  await addTrade(venueA, tokenA, BASE_BLOCK + 1, '1', 'buy', 1_700_000_001);
  await addTrade(venueB, tokenB, BASE_BLOCK + 2, '2', 'sell', 1_700_000_002);
  await addTrade(venueA, tokenA, BASE_BLOCK + 3, '3', 'buy', 1_700_000_003);
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE venue_id = ANY($1)', [[venueA, venueB]]);
  await pool.query('DELETE FROM venues WHERE id = ANY($1)', [[venueA, venueB]]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('listAllTransactions', () => {
  it('returns the newest official trades across launches, each labelled with its launch', async () => {
    const page = await store.listAllTransactions!({ limit: 3 });
    expect(page.items.map((row) => [row.token.symbol, row.blockNumber])).toEqual([
      ['GTA', String(BASE_BLOCK + 3)], ['GTB', String(BASE_BLOCK + 2)], ['GTA', String(BASE_BLOCK + 1)],
    ]);
    expect(page.items[1]).toMatchObject({ side: 'sell', tokenAmount: '2', quoteAmount: '1', quoteAsset: { symbol: 'ETH' } });
  });

  it('pages with a cursor without repeating or skipping rows', async () => {
    const first = await store.listAllTransactions!({ limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listAllTransactions!({ limit: 2, cursor: first.nextCursor! });
    expect(second.items[0]!.blockNumber).toBe(String(BASE_BLOCK + 1));
  });

  it('filters by chain', async () => {
    expect((await store.listAllTransactions!({ limit: 5, chainId: 999_999 })).items).toEqual([]);
  });
});
