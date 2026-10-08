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
  it('excludes a pool that is the Pons official venue when excludeOfficial is set', async () => {
    const source = 'pools-exclude-official-source';
    const venueId = `4663:v4_pool:${ids[0]}`;
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,4663,'v1',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [source, a]);
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,NULL,'Official','OFF',18,'pons','v2',$1,$1,1,$3,9,$1,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
    [a, source, `0x${'8'.repeat(64)}`]);
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,'v4_pool',$3,$4,NULL,1,true) ON CONFLICT (id) DO NOTHING`, [venueId, a, ids[0], source]);
    try {
      const all = await store.listPools({ chainId: 4663, limit: 10, tokenAddress: a });
      expect(all.items.map((item) => item.poolId)).toContain(ids[0]);
      const others = await store.listPools({ chainId: 4663, limit: 10, tokenAddress: a, excludeOfficial: true });
      expect(others.items).toEqual([]);
    } finally {
      await pool.query('DELETE FROM venues WHERE id = $1', [venueId]);
      await pool.query('DELETE FROM launches WHERE chain_id = 4663 AND token_address = $1', [a]);
      await pool.query('DELETE FROM sources WHERE id = $1', [source]);
    }
  });

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
  it('leaves currency decimals null when no rpcClient is configured', async () => {
    const pool0 = await store.getPool({ chainId: 4663, protocol: 'uniswap_v4', poolId: ids[0] });
    expect(pool0?.currency0Decimals).toBeNull();
    expect(pool0?.currency1Decimals).toBeNull();
    expect(pool0?.poolBalances).toBeNull();
  });
  it('resolves currency decimals on-chain when an rpcClient is configured', async () => {
    // Stub rpcClient so decimals resolution (assetDecimals) doesn't need a real chain —
    // mirrors the pattern in store.integration.test.ts's own txRpcClient fixture.
    const rpcClient = {
      async getBlockNumber() { return 300n; },
      async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'decimals') return 18;
      if (functionName === 'getPoolTVL') return {
        coreAmount0: 3n * 10n ** 18n, coreAmount1: 2n * 10n ** 18n,
        sqrtPriceX96: 2n ** 96n, hasCustomAccounting: false,
      };
      throw new Error(`Unexpected ${functionName}`);
      },
    };
    const storeWithRpc = createPoolApiStore(pool, rpcClient);
    const pool0 = await storeWithRpc.getPool({ chainId: 4663, protocol: 'uniswap_v4', poolId: ids[0] });
    expect(pool0?.currency0Decimals).toBe(18);
    expect(pool0?.currency1Decimals).toBe(18);
    expect(pool0?.poolBalances).toEqual({ displayedAmountRaw: '3000000000000000000',
      otherAmountRaw: '2000000000000000000', priceInQuote: '1' });
  });
});
