import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { encodeAbiParameters, keccak256 } from 'viem';
import { createPoolApiStore } from './poolStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const store = createPoolApiStore(pool);
const a = '0x3131313131313131313131313131313131313131';
const b = '0x3232323232323232323232323232323232323232';
const c = '0x3333333333333333333333333333333333333333';
const hook = '0x0000000000000000000000000000000000000000';
const id = (x: string, y: string) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [x as `0x${string}`, y as `0x${string}`, 3000, 60, hook],
));
const ids = [id(a, b), id(b, c)];
beforeAll(async () => {
  for (const [index, [currency0, currency1]] of [[a, b], [b, c]].entries()) {
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
      block_number,block_hash,tx_hash,log_index,verified,coverage_status)
      VALUES (4663,'uniswap_v4',$1,$2,$3,3000,60,$4,$5,$6,$6,0,true,'backfilling') ON CONFLICT DO NOTHING`,
    [ids[index], currency0, currency1, hook, 999999990 + index, `0x${String(index + 1).repeat(64)}`]);
    for (const token of [currency0, currency1]) await pool.query(`INSERT INTO pool_members
      (chain_id,protocol,pool_id,token_address) VALUES (4663,'uniswap_v4',$1,$2) ON CONFLICT DO NOTHING`, [ids[index], token]);
  }
});
afterAll(async () => { await pool.query('DELETE FROM pool_catalog WHERE pool_id = ANY($1)', [ids]); await pool.end(); });
describe('pool catalog API reader', () => {
  it('paginates with deterministic ties and preserves exact membership', async () => {
    const first = await store.listPools({ chainId: 4663, limit: 1, tokenAddress: b });
    expect(first.items).toHaveLength(1);
    expect(first.items[0].displayedToken).toBe(b);
    expect(first.items[0].volume24hUsd).toBeNull();
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listPools({ chainId: 4663, limit: 1, tokenAddress: b, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].poolId).not.toBe(first.items[0].poolId);
    expect(second.nextCursor).toBeNull();
    const exact = await store.listPools({ chainId: 4663, limit: 10, tokenAddress: a });
    expect(exact.items.map((x) => x.poolId)).toEqual([ids[0]]);
    expect((await store.listPools({ chainId: 1, limit: 10, tokenAddress: a })).items).toEqual([]);
  });
  it('rejects a side outside the verified pair and an invalid cursor', async () => {
    expect(await store.getPool({ chainId: 4663, protocol: 'uniswap_v4', poolId: ids[0] }, c)).toBeNull();
    await expect(store.listPools({ limit: 1, cursor: 'garbage' })).rejects.toThrow('Invalid pool cursor');
  });
});
