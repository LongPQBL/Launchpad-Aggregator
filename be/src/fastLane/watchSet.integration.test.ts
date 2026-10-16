import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { createWatchSetLoader, isWatched, loadWatchSet } from './watchSet.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const chainId = 4663;
const source = 'fast-lane-watch-test';
const token = '0x7a00000000000000000000000000000000000001';
const refs = { curve: '0x7a000000000000000000000000000000000000c1', v3: '0x7a000000000000000000000000000000000000a3', v4: `0x${'7a'.repeat(32)}` };
const general = { v3: '0x7a000000000000000000000000000000000000b3', v4: `0x${'7b'.repeat(32)}` };

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol,
    quote_asset_decimals, lifecycle_status) VALUES ($1,$2,$3,'W','W',18,'pons','v2',$2,$2,1,$4,0,$2,'WETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'7a'.repeat(32)}`]);
  for (const [kind, ref] of [['curve', refs.curve.toUpperCase().replace('0X', '0x')], ['v3_pool', refs.v3], ['v4_pool', refs.v4]] as const) {
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1,$2,$3,$4,$5,$6,1,true) ON CONFLICT DO NOTHING`, [`watch-${kind}`, chainId, token, kind, ref, source]);
  }
  for (const [protocol, id] of [['uniswap_v3', general.v3], ['uniswap_v4', general.v4]] as const) {
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
      block_number,block_hash,tx_hash,log_index,verified)
      VALUES ($1,$2,$3,$4,$5,3000,60,$4,2,$6,$6,0,true) ON CONFLICT DO NOTHING`,
    [chainId, protocol, id, token, '0x8a00000000000000000000000000000000000001', `0x${'7a'.repeat(32)}`]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=ANY($2)', [chainId, Object.values(general)]);
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('loadWatchSet', () => {
  it('lists the curve, V3 pool and V4 pool venues of the chain, lower-cased', async () => {
    const set = await loadWatchSet(pool, chainId);
    expect(set.curve.has(refs.curve)).toBe(true);
    expect(set.v3_pool.has(refs.v3)).toBe(true);
    expect(set.v4_pool.has(refs.v4)).toBe(true);
    expect(set.v3_pool.has(general.v3)).toBe(true);
    expect(set.v4_pool.has(general.v4)).toBe(true);
    expect(isWatched(set, { watchKind: 'curve', watchRef: refs.curve })).toBe(true);
    expect(isWatched(set, { watchKind: 'curve', watchRef: refs.v3 })).toBe(false); // right address, wrong kind
    expect(isWatched(set, { watchKind: 'v4_pool', watchRef: `0x${'00'.repeat(32)}` })).toBe(false);
  });
  it('does not list another chain', async () => {
    const set = await loadWatchSet(pool, 1);
    expect(set.curve.has(refs.curve)).toBe(false);
  });
});

describe('createWatchSetLoader', () => {
  const lateRef = '0x7a000000000000000000000000000000000000d4';
  const lateId = 'watch-late';

  it('reads every venue the first time, then only the ones added since, and a full reload again after the interval', async () => {
    let clock = 0;
    const queries: string[] = [];
    const spy = { query: (text: string, values?: unknown[]) => { queries.push(text); return pool.query(text, values as never); } };
    const loader = createWatchSetLoader(spy as never, chainId, { fullReloadEveryMs: 1_000, now: () => clock });

    const first = await loader.refresh();
    expect(first.curve.has(refs.curve)).toBe(true);
    expect(queries[0]).not.toContain('seq >');

    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1,$2,$3,'v3_pool',$4,$5,1,true) ON CONFLICT DO NOTHING`, [lateId, chainId, token, lateRef, source]);
    expect(first.v3_pool.has(lateRef)).toBe(false);

    clock = 500;
    const second = await loader.refresh();
    expect(queries.filter((query) => query.includes('FROM venues v'))[1]).toContain('seq >');
    expect(second.v3_pool.has(lateRef)).toBe(true);
    expect(second.curve.has(refs.curve)).toBe(true); // what was already known is kept
    expect(first.v3_pool.has(lateRef)).toBe(false); // the set handed out earlier is never mutated

    await pool.query('DELETE FROM venues WHERE id = $1', [lateId]);
    clock = 600;
    expect((await loader.refresh()).v3_pool.has(lateRef)).toBe(true); // a deleted venue lingers until the full reload (harmless)
    clock = 2_000;
    const reloaded = await loader.refresh();
    expect(queries.filter((query) => query.includes('FROM venues v')).at(-1)).not.toContain('seq >');
    expect(reloaded.v3_pool.has(lateRef)).toBe(false);
  });
});
