import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createSearchStore } from './searchStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const store = createSearchStore(pool);

const chainId = 4663;
const source = 'search-test-src';
const tokenA = `0x${'5a'.repeat(20)}`;
const tokenB = `0x${'5b'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const poolId = `0x${'5c'.repeat(32)}`;
const hash = (c: string) => `0x${c.repeat(64)}`;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'5d'.repeat(20)}`]);
  for (const [index, [token, name, symbol]] of [[tokenA, 'Zorbtoken Alpha', 'ZRBA'], [tokenB, 'Other 50% Thing', 'OTH']].entries()) {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
      protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
      quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES ($1, $2, $3, $4, $5, 18, 'pons', 'v2', $2, $2, $6, $7, 0, $8, 'ETH', 18, 'trading') ON CONFLICT DO NOTHING`,
    [chainId, token, source, name, symbol, 900000000 + index, hash(String(index + 1)), quote]);
  }
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
    block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,900000010,$6,$6,0,true,'backfilling') ON CONFLICT DO NOTHING`,
  [chainId, poolId, quote, tokenA, quote, hash('9')]);
  for (const token of [quote, tokenA]) {
    await pool.query(`INSERT INTO pool_members (chain_id,protocol,pool_id,token_address) VALUES ($1,'uniswap_v4',$2,$3) ON CONFLICT DO NOTHING`,
      [chainId, poolId, token]);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE pool_id = $1', [poolId]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('search store', () => {
  it('finds a token by name or symbol, case-insensitively', async () => {
    const byName = await store.search('zorbtoken', 5);
    expect(byName.tokens.map((token) => token.tokenAddress)).toEqual([tokenA]);
    expect((await store.search('zrba', 5)).tokens[0]).toMatchObject({ tokenAddress: tokenA, symbol: 'ZRBA', platform: 'pons' });
  });

  it('finds a token by its exact address', async () => {
    expect((await store.search(tokenB, 5)).tokens.map((token) => token.tokenAddress)).toEqual([tokenB]);
  });

  it('returns the pool of a matching launch token, labelled with that launch token', async () => {
    const result = await store.search('zorbtoken', 5);
    expect(result.pools).toEqual([expect.objectContaining({ protocol: 'uniswap_v4', poolId, launchToken: expect.objectContaining({ address: tokenA, symbol: 'ZRBA' }) })]);
  });

  it('finds a pool by its id', async () => {
    expect((await store.search(poolId, 5)).pools.map((hit) => hit.poolId)).toEqual([poolId]);
  });

  it('treats % and _ as literal text, not wildcards', async () => {
    expect((await store.search('50%', 5)).tokens.map((token) => token.tokenAddress)).toEqual([tokenB]);
    expect((await store.search('z_rb', 5)).tokens).toEqual([]);
  });

  it('returns nothing for a query shorter than two characters', async () => {
    expect(await store.search('z', 5)).toEqual({ tokens: [], pools: [] });
  });
});
