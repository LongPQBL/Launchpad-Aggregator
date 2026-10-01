import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { launches, venues, trades, lifecycleTransitions, launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { reconcileReorgWindow } from './reorgGuard.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const source = 'envio-guard-test';
// Represents the RPC-scan indexer's own venue registration — deliberately a DIFFERENT sourceId than
// `source` above. Venues are shared between the RPC indexer and Envio (same deterministic venueKey,
// onConflictDoNothing on insert), so for any token that already exists, the venue almost always
// carries the RPC indexer's own sourceId, not an Envio one. A prior version of this fixture used
// `source` for the venue's sourceId too, which hid a real bug (final review, Critical 1): filtering
// trade deletion by venue sourceId made every Envio trade on an RPC-created venue invisible to reorg
// reconciliation. This fixture now pins that exact shape.
const rpcVenueSource = 'rpc-indexer-test';
const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const poolId = `4663:v3_pool:${token}`;
const curveId = `4663:curve:${token}`;
const rawLogId = 'envio-guard-test-raw';
const tx = (digit: string) => `0x${digit.repeat(64)}`;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
    VALUES ($1,4663,'v1',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [source, token]);
  await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
    VALUES ($1,4663,'v1',$2,0,0,0,'caught_up') ON CONFLICT DO NOTHING`, [rpcVenueSource, token]);
  await pool.query(`INSERT INTO raw_logs (id,chain_id,source_id,block_number,block_hash,tx_hash,log_index,address,topics,data)
    VALUES ($1,4663,$2,999990,$3,$4,0,$5,'[]','0x') ON CONFLICT DO NOTHING`, [rawLogId, source, tx('a'), tx('9'), token]);
  await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
    platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
    quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
    VALUES (4663,$1,$2,NULL,'Old','OLD',18,'pons','v1',$1,$1,100,$3,0,$1,'ETH',18,'trading')`, [token, source, tx('1')]);
  for (const [id, kind] of [[poolId, 'v3_pool'], [curveId, 'curve']]) {
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,$3,$1,$4,NULL,100,true)`, [id, token, kind, rpcVenueSource]);
  }
  for (const [id, block, txHash, sourceLogId] of [
    [poolId, 100, tx('2'), null], [poolId, 999900, tx('3'), null],
    [poolId, 999990, tx('9'), rawLogId], [curveId, 999900, tx('4'), null],
  ] as const) {
    await pool.query(`INSERT INTO trades (chain_id,token_address,venue_id,block_number,block_hash,tx_hash,log_index,
      timestamp,side,token_amount_raw,quote_amount_raw,quote_asset_address,source_event,activity_kind,source_log_id,trader_address)
      VALUES (4663,$1,$2,$3,$4,$5,0,1,'buy','1','1',$1,'Swap','user_trade',$6,$1)`,
    [token, id, block, tx('a'), txHash, sourceLogId]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM launches WHERE token_address = $1', [token]);
  await pool.query('DELETE FROM raw_logs WHERE id = $1', [rawLogId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [rpcVenueSource]);
  await pool.end();
});

describe('reorg window', () => {
  it('deletes only Envio rows in the window, even on a venue the RPC indexer created, retaining old and RPC rows', async () => {
    await reconcileReorgWindow(db, { launches, venues, trades, lifecycleTransitions }, 999500n,
      { venueKinds: ['v3_pool'], launchSourceIds: [source] });
    const result = await pool.query('SELECT tx_hash FROM trades WHERE token_address = $1 ORDER BY tx_hash', [token]);
    expect(result.rows.map((row) => row.tx_hash)).toEqual([tx('2'), tx('4'), tx('9')]);
    expect((await pool.query('SELECT count(*)::int AS count FROM launches WHERE token_address = $1', [token])).rows[0].count).toBe(1);
  });

  it('also reconciles the staging table set', async () => {
    const stagingToken = '0xcccccccccccccccccccccccccccccccccccccccc';
    await pool.query(`INSERT INTO launches_envio_staging (chain_id,token_address,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,'S','S',18,'pons','v1',$1,$1,999900,$2,$1,'ETH',18,'trading')`, [stagingToken, tx('c')]);
    await reconcileReorgWindow(db, { launches: launchesEnvioStaging, venues: venuesEnvioStaging, trades: tradesEnvioStaging }, 999500n);
    const rows = await pool.query('SELECT token_address FROM launches_envio_staging WHERE token_address = $1', [stagingToken]);
    expect(rows.rows).toHaveLength(0);
  });
});
