import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readPoolCandles, readPoolHighLow, refreshDirtyPoolCandles } from './candleCache.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 996637;
const id = `0x${'e'.repeat(64)}`;
const tx = `0x${'f'.repeat(64)}`;
const address0 = '0x1111111111111111111111111111111111111111';
const address1 = '0x2222222222222222222222222222222222222222';

beforeAll(async () => {
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
    block_number,block_hash,tx_hash,log_index,verified)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,100,$6,$7,0,true)
    ON CONFLICT DO NOTHING`, [chainId, id, address0, address1, address0, tx, tx]);
});
afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, id]);
  await pool.query('DELETE FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND pool_id=$2', [chainId, id]);
  await pool.end();
});

describe('pool candle cache', () => {
  it('rebuilds only this pool, then removes stale candles after a reorg deletion', async () => {
    await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,
      timestamp,amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
      VALUES ($1,$2,0,'uniswap_v4',$3,101,$4,1740,-1,2,$5,$6,$6,3000) ON CONFLICT DO NOTHING`,
    [chainId, tx, id, tx, (2n ** 96n).toString(), address0]);
    expect((await pool.query('SELECT count(*)::int AS n FROM pool_candle_dirty_buckets WHERE chain_id=$1', [chainId])).rows[0].n).toBe(1);
    expect(await refreshDirtyPoolCandles(pool, 10)).toBeGreaterThan(0);
    const candles = (await pool.query('SELECT interval_seconds,trade_count FROM pool_candles WHERE chain_id=$1', [chainId])).rows;
    expect(candles).toHaveLength(5);
    expect(candles.every((row) => row.trade_count === 1)).toBe(true);
    await pool.query("UPDATE pool_catalog SET coverage_status='caught_up' WHERE chain_id=$1", [chainId]);
    const chart = await readPoolCandles(pool, { chainId, protocol: 'uniswap_v4', poolId: id }, address0, 60, 1800,
      { rpcClient: { readContract: async () => 18 } });
    expect(chart).toMatchObject({ complete: true, items: [{ bucketStart: 1740, open: '1', close: '1' }] });
    expect(await readPoolHighLow(pool, { chainId, protocol: 'uniswap_v4', poolId: id }, address0, 1800,
      { rpcClient: { readContract: async () => 18 } })).toEqual({ high: '1', low: '1', complete: true });
    await pool.query('DELETE FROM pool_trades WHERE chain_id=$1 AND tx_hash=$2', [chainId, tx]);
    await refreshDirtyPoolCandles(pool, 10);
    expect((await pool.query('SELECT count(*)::int AS n FROM pool_candles WHERE chain_id=$1', [chainId])).rows[0].n).toBe(0);
  });
});
