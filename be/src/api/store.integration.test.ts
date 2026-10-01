import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { createApiStore } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const store = createApiStore(pool);
const source = 'envio-store-test';
const tokens = ['0x1313131313131313131313131313131313131313', '0x1414141414141414141414141414141414141414',
  '0x1515151515151515151515151515151515151515'];
const blockHash = '0x' + 'a'.repeat(64);
const txHash = '0x' + 'b'.repeat(64);
const blockNumber = 999999999n;
const rawLogId = `4663:${blockHash}:${txHash}:4`;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
    VALUES ($1,4663,'v1',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [source, tokens[0]]);
  await pool.query(`INSERT INTO raw_logs (id,chain_id,source_id,block_number,block_hash,tx_hash,log_index,address,topics,data)
    VALUES ($1,4663,$2,$3,$4,$5,4,$6,'[]','0x') ON CONFLICT DO NOTHING`,
  [rawLogId, source, blockNumber.toString(), blockHash, txHash, tokens[0]]);
  for (const [i, logIndex] of [5, 4, 2].entries()) {
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,$3,$4,'T',18,'pons','v1',$1,$1,$5,$6,$7,$1,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
    [tokens[i], source, i === 1 ? rawLogId : null, `Token${i}`, blockNumber.toString(), txHash, logIndex]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM launches WHERE token_address = ANY($1)', [tokens]);
  await pool.query('DELETE FROM raw_logs WHERE id = $1', [rawLogId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('listLaunches without raw log provenance', () => {
  it('includes null-source rows and preserves block/tx/log pagination across old and new rows', async () => {
    const first = await store.listLaunches({ limit: 1, chainId: 4663 });
    expect(first.items[0].tokenAddress).toBe(tokens[0]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listLaunches({ limit: 1, chainId: 4663, cursor: first.nextCursor! });
    expect(second.items[0].tokenAddress).toBe(tokens[1]);
    const third = await store.listLaunches({ limit: 1, chainId: 4663, cursor: second.nextCursor! });
    expect(third.items[0].tokenAddress).toBe(tokens[2]);
  });
});

describe('safe head considers envio_chain_progress (final review, Important 3)', () => {
  const headToken = '0x1616161616161616161616161616161616161616';
  const headSource = 'envio-store-head-test';
  const headBlock = 99_999_999_999n;

  afterAll(async () => {
    await pool.query('DELETE FROM venues WHERE token_address = $1', [headToken]);
    await pool.query('DELETE FROM launches WHERE token_address = $1', [headToken]);
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[headSource, `${headSource}-trades`]]);
    await pool.query('DELETE FROM envio_chain_progress WHERE chain_id = 4663');
  });

  it('reports a launch as complete once envio_chain_progress reflects a head its source has reached, with no observed_blocks rows at all', async () => {
    // launchpad_test has no observed_blocks rows for chain 4663 (confirmed separately) — so with
    // envio_chain_progress also empty, safeHead must be null and coverage incomplete. Once
    // envio_chain_progress is set, safeHead must reflect it (GREATEST(NULL, headBlock) = headBlock).
    for (const id of [headSource, `${headSource}-trades`]) {
      await pool.query(`INSERT INTO sources (id,chain_id,version,factory_address,start_block,scanned_to_block,confirmed_to_block,status)
        VALUES ($1,4663,'v1',$2,0,0,$3,'caught_up') ON CONFLICT (id) DO UPDATE SET confirmed_to_block = $3, status = 'caught_up'`,
      [id, headToken, headBlock.toString()]);
    }
    await pool.query(`INSERT INTO launches (chain_id,token_address,source_id,source_log_id,name,symbol,token_decimals,
      platform,protocol_version,factory_address,deployer_address,launch_block,launch_tx_hash,launch_log_index,
      quote_asset_address,quote_asset_symbol,quote_asset_decimals,lifecycle_status)
      VALUES (4663,$1,$2,NULL,'HeadTest','HT',18,'pons','v1',$1,$1,1,$3,0,$1,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
    [headToken, headSource, '0x' + 'e'.repeat(64)]);
    await pool.query(`INSERT INTO venues (id,chain_id,token_address,kind,ref,source_id,source_log_id,effective_from_block,official)
      VALUES ($1,4663,$2,'v3_pool',$2,$3,NULL,1,true) ON CONFLICT (id) DO NOTHING`,
    [`4663:v3_pool:${headToken}`, headToken, headSource]);

    const beforeHead = await store.getLaunch(4663, headToken);
    expect(beforeHead?.coverageStatus).toBe('backfilling');

    await pool.query(`INSERT INTO envio_chain_progress (chain_id, head_block) VALUES (4663, $1)
      ON CONFLICT (chain_id) DO UPDATE SET head_block = $1`, [headBlock.toString()]);

    const afterHead = await store.getLaunch(4663, headToken);
    expect(afterHead?.coverageStatus).toBe('caught_up');
  });
});
