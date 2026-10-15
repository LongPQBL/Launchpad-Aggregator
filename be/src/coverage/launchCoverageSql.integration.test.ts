import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { launchCoverageSql } from './launchCoverageSql.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const chainId = 996642;
const factorySource = 'coverage-fast-lane-factory';
const tradeSource = `${factorySource}-trades`;
const token = '0x7c00000000000000000000000000000000000001';
const venueId = 'coverage-fast-lane-venue';
const head = 1000n;

beforeAll(async () => {
  for (const id of [factorySource, tradeSource]) {
    await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
      VALUES ($1,$2,'v1',$3,0,$4,$4,'caught_up') ON CONFLICT (id) DO UPDATE SET
      chain_id=$2, confirmed_to_block=$4, status='caught_up'`, [id, chainId, token, head.toString()]);
  }
  await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,name,symbol,token_decimals,platform,protocol_version,
    factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,quote_asset_address,quote_asset_symbol,
    quote_asset_decimals,lifecycle_status)
    VALUES ($1,$2,$3,'Coverage','COV',18,'pons','v1',$2,$2,1,$4,0,$2,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, factorySource, `0x${'7c'.repeat(32)}`]);
  await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,effective_from_block,official)
    VALUES ($1,$2,$3,'v3_pool',$3,$4,1,true) ON CONFLICT (id) DO NOTHING`, [venueId, chainId, token, tradeSource]);
  await pool.query(`INSERT INTO fast_lane_state (chain_id,last_block,coverage_block) VALUES ($1,$2,$2)
    ON CONFLICT (chain_id) DO UPDATE SET last_block=$2, coverage_block=$2`, [chainId, head.toString()]);
  await pool.query(`INSERT INTO fast_lane_venue_coverage (chain_id,venue_id,envio_bridge_block) VALUES ($1,$2,900)
    ON CONFLICT (chain_id,venue_id) DO UPDATE SET envio_bridge_block=900`, [chainId, venueId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM fast_lane_venue_coverage WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM fast_lane_state WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM venues WHERE id = $1', [venueId]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[factorySource, tradeSource]]);
  await pool.end();
});

async function coverage(): Promise<boolean> {
  const result = await pool.query(`SELECT ${launchCoverageSql(1)} AS complete FROM launches l
    WHERE l.chain_id = $2 AND l.token_address = $3`, [head.toString(), chainId, token]);
  return result.rows[0]?.complete === true;
}

describe('launchCoverageSql source alternatives', () => {
  it('accepts a current Envio trade-source watermark', async () => {
    await pool.query('UPDATE sources SET confirmed_to_block = $1 WHERE id = $2', [head.toString(), tradeSource]);
    expect(await coverage()).toBe(true);
  });

  it('accepts the contiguous lane watermark when Envio trails but has bridged this venue', async () => {
    await pool.query('UPDATE sources SET confirmed_to_block = 950 WHERE id = $1', [tradeSource]);
    expect(await coverage()).toBe(true);
  });

  it('does not let lane coverage waive a factory source that is behind', async () => {
    await pool.query('UPDATE sources SET confirmed_to_block = 999 WHERE id = $1', [factorySource]);
    expect(await coverage()).toBe(false);
    await pool.query('UPDATE sources SET confirmed_to_block = $1 WHERE id = $2', [head.toString(), factorySource]);
  });

  it('does not use lane coverage before Envio reaches the venue bridge', async () => {
    await pool.query('UPDATE sources SET confirmed_to_block = 950 WHERE id = $1', [tradeSource]);
    await pool.query('UPDATE fast_lane_venue_coverage SET envio_bridge_block = 951 WHERE venue_id = $1', [venueId]);
    expect(await coverage()).toBe(false);
    await pool.query('UPDATE fast_lane_venue_coverage SET envio_bridge_block = 900 WHERE venue_id = $1', [venueId]);
  });

  it('does not accept a lane watermark below the safe head', async () => {
    await pool.query('UPDATE sources SET confirmed_to_block = 950 WHERE id = $1', [tradeSource]);
    await pool.query('UPDATE fast_lane_state SET coverage_block = 999 WHERE chain_id = $1', [chainId]);
    expect(await coverage()).toBe(false);
    await pool.query('UPDATE fast_lane_state SET coverage_block = $1 WHERE chain_id = $2', [head.toString(), chainId]);
  });
});
