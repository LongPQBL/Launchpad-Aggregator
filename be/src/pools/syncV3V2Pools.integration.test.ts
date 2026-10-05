import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { createPoolApiStore } from '../api/poolStore.js';
import { ensureAdditionalPoolSourceAudit, repairV3V2PoolWindow, syncV3V2PoolPage,
  updateAdditionalPoolCoverage, v2SqrtPriceX96 } from './syncV3V2Pools.js';
import { V2_FACTORY, V3_FACTORY } from './sourceRegistry.js';
import { comparePoolSourceWindow, recordPoolSourceParity } from './parity.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const envio = new Pool({ connectionString: databaseUrl });
const schema = 'envio_fixture_additional_pools';
const tables = { v3_created: `${schema}."RawV3PoolCreated"`, v3_swap: `${schema}."RawV3Swap"`,
  v2_created: `${schema}."RawV2PairCreated"`, v2_swap: `${schema}."RawV2Swap"`, v2_sync: `${schema}."RawV2Sync"` };
const chainId = 4663;
const a = '0x6161616161616161616161616161616161616161';
const b = '0x6262626262626262626262626262626262626262';
const v3 = '0x6363636363636363636363636363636363636363';
const v2 = '0x6464646464646464646464646464646464646464';
const lateV3 = '0x6565656565656565656565656565656565656565';
const h = (digit: string) => `0x${digit.repeat(64)}`;
const raw = (id: string, block: number, log: number, digit: string) =>
  [id, chainId, block, h(digit), h(digit), log];

beforeAll(async () => {
  await envio.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  for (const [name, extra] of [
    ['RawV3PoolCreated', '"factoryAddress" text,"poolAddress" text,"token0" text,"token1" text,"fee" integer,"tickSpacing" integer'],
    ['RawV2PairCreated', '"factoryAddress" text,"pairAddress" text,"token0" text,"token1" text'],
    ['RawV3Swap', '"poolAddress" text,"txFrom" text,"sender" text,"amount0" text,"amount1" text,"sqrtPriceX96" text,"timestamp" integer'],
    ['RawV2Swap', '"pairAddress" text,"txFrom" text,"sender" text,"amount0In" text,"amount1In" text,"amount0Out" text,"amount1Out" text,"timestamp" integer'],
    ['RawV2Sync', '"pairAddress" text,"reserve0" text,"reserve1" text'],
  ]) await envio.query(`CREATE TABLE IF NOT EXISTS ${schema}."${name}" (id text primary key,"chainId" integer,
    "blockNumber" bigint,"blockHash" text,"txHash" text,"logIndex" integer,${extra})`);
  await envio.query(`INSERT INTO ${tables.v3_created} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT DO NOTHING`, [...raw('v3-create', 999999000, 1, '1'), V3_FACTORY, v3, a, b, 3000, 60]);
  await envio.query(`INSERT INTO ${tables.v2_created} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT DO NOTHING`, [...raw('v2-create', 999999001, 1, '2'), V2_FACTORY, v2, a, b]);
  await envio.query(`INSERT INTO ${tables.v3_swap} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT DO NOTHING`, [...raw('v3-swap', 999999002, 2, '3'), v3, a, a, '-1000000000000000000', '1000000000000000000', (2n ** 96n).toString(), 1000]);
  await envio.query(`INSERT INTO ${tables.v2_sync} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT DO NOTHING`, [...raw('v2-sync', 999999003, 2, '4'), v2, '100', '400']);
  await envio.query(`INSERT INTO ${tables.v2_swap} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT DO NOTHING`, [...raw('v2-swap', 999999003, 3, '4'), v2, a, a, '10', '0', '0', '20', 1001]);
});
afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id IN ($2,$3,$4)', [chainId, v3, v2, lateV3]);
  await pool.query(`DELETE FROM pool_pending_swaps WHERE raw_id IN ('v3-swap','v2-swap','v3-late-swap')`);
  await pool.query(`DELETE FROM pool_sync_cursors WHERE chain_id=$1 AND stream LIKE 'v%_%'`, [chainId]);
  await pool.query(`DELETE FROM pool_source_audits WHERE chain_id=$1 AND protocol IN ('uniswap_v3','uniswap_v2')`, [chainId]);
  await envio.query(`DROP SCHEMA ${schema} CASCADE`);
  await envio.end(); await pool.end();
});

describe('V3/V2 pool source promotion', () => {
  it('promotes only factory verified pair identities, exact members and unique swaps', async () => {
    await ensureAdditionalPoolSourceAudit(db, chainId);
    for (const stream of ['v3_created', 'v2_created', 'v3_swap', 'v2_swap'] as const) {
      const result = await syncV3V2PoolPage(envio, db, { chainId, stream, lane: 'history', fence: 999999010n,
        limit: 10, tables });
      expect(result.applied).toBe(1);
      const replay = await syncV3V2PoolPage(envio, db, { chainId, stream, lane: 'history', fence: 999999010n,
        limit: 10, tables });
      expect(replay.applied).toBe(0);
    }
    expect(v2SqrtPriceX96(100n, 400n)).toBe(2n * 2n ** 96n);
    const rows = await pool.query(`SELECT protocol,pool_id FROM pool_catalog WHERE pool_id IN ($1,$2) ORDER BY protocol`, [v3, v2]);
    expect(rows.rows).toHaveLength(2);
    const swaps = await pool.query(`SELECT protocol,pool_id FROM pool_trades WHERE pool_id IN ($1,$2)`, [v3, v2]);
    expect(swaps.rows).toHaveLength(2);
    const members = await pool.query('SELECT token_address FROM pool_members WHERE pool_id=$1 ORDER BY token_address', [v3]);
    expect(members.rows.map((row) => row.token_address)).toEqual([a, b]);
    await updateAdditionalPoolCoverage(db, chainId, 999999010n);
    const publicPage = await createPoolApiStore(pool).listPools({ chainId, tokenAddress: a, limit: 20 });
    expect(publicPage.items.map((item) => item.poolId)).not.toContain(v3);
    expect(publicPage.items.map((item) => item.poolId)).not.toContain(v2);
  });
  it('compares bounded canonical source logs and detects a missing Envio event', async () => {
    const rpc = { async getLogs({ address }: { address: string }) {
      const digit = address === V3_FACTORY ? '1' : '3';
      return [{ blockNumber: '0x1', blockHash: h(digit), transactionHash: h(digit),
        logIndex: address === V3_FACTORY ? '0x1' : '0x2' }];
    } };
    const matched = await comparePoolSourceWindow(envio, rpc, { chainId, protocol: 'uniswap_v3',
      fromBlock: 999999000n, toBlock: 999999010n, samplePoolAddress: v3, tables });
    expect(matched.complete).toBe(true);
    expect(matched.mismatches).toEqual([]);
    expect(await recordPoolSourceParity(db, matched, chainId, 999998510n)).toBe('complete');
    const missing = await comparePoolSourceWindow(envio, { getLogs: async () => [] }, { chainId,
      protocol: 'uniswap_v3', fromBlock: 999999000n, toBlock: 999999010n,
      samplePoolAddress: v3, tables });
    expect(missing.complete).toBe(false);
    expect(missing.mismatches).toHaveLength(2);
    expect(await recordPoolSourceParity(db, missing, chainId, 999998510n)).toBe('mismatch');
  });
  it('removes only the source swap on a reorg and rewinds its cursor', async () => {
    await envio.query(`DELETE FROM ${tables.v3_swap} WHERE id='v3-swap'`);
    const report = await repairV3V2PoolWindow(envio, db, { chainId, source: 'uniswap_v3',
      fence: 999999010n, depth: 20n, tables });
    expect(report.removedSwaps).toBe(1);
    const other = await pool.query('SELECT 1 FROM pool_trades WHERE pool_id=$1', [v2]);
    expect(other.rowCount).toBe(1);
  });
  it('retries a swap that arrived before its factory pool row', async () => {
    await envio.query(`INSERT INTO ${tables.v3_swap} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [...raw('v3-late-swap', 999999020, 2, '5'), lateV3, a, a, '-1', '1', (2n ** 96n).toString(), 1002]);
    const first = await syncV3V2PoolPage(envio, db, { chainId, stream: 'v3_swap', lane: 'history',
      fence: 999999030n, limit: 10, tables });
    expect(first.pending).toBe(1);
    await envio.query(`INSERT INTO ${tables.v3_created} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [...raw('v3-late-create', 999999019, 1, '6'), V3_FACTORY, lateV3, a, b, 3000, 60]);
    const repaired = await syncV3V2PoolPage(envio, db, { chainId, stream: 'v3_created', lane: 'history',
      fence: 999999030n, limit: 10, tables });
    expect(repaired.applied).toBe(2);
    const trade = await pool.query('SELECT 1 FROM pool_trades WHERE pool_id=$1', [lateV3]);
    expect(trade.rowCount).toBe(1);
  });
});
