import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, fastLaneState, trades } from '../db/schema.js';
import { advanceLaneBlock, readLaneBlock, recordFastRows, removeLaneTrade } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const chainId = 996641; // a private chain id: no other test touches it
const source = 'fast-lane-store-test';
const token = '0x7b00000000000000000000000000000000000001';
const txHash = `0x${'7b'.repeat(32)}`;
const blockHash = `0x${'7c'.repeat(32)}`;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol,
    quote_asset_decimals, lifecycle_status) VALUES ($1,$2,$3,'S','S',18,'pons','v2',$2,$2,1,$4,0,$2,'WETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'7b'.repeat(32)}`]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ('store-venue', $1, $2, 'curve', $2, $3, 1, true) ON CONFLICT DO NOTHING`, [chainId, token, source]);
});
afterAll(async () => {
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  await db.delete(trades).where(eq(trades.chainId, chainId));
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('lane state', () => {
  it('starts empty, stores the highest block and never moves backwards', async () => {
    expect(await readLaneBlock(db, chainId)).toBeNull();
    await advanceLaneBlock(db, chainId, 500n);
    await advanceLaneBlock(db, chainId, 400n);
    expect(await readLaneBlock(db, chainId)).toBe(500n);
    await advanceLaneBlock(db, chainId, 501n);
    expect(await readLaneBlock(db, chainId)).toBe(501n);
  });
});

describe('recordFastRows', () => {
  it('keeps the raw row by (chain, tx hash, log index) and ignores a repeat', async () => {
    const entry = { stream: 'v2-curve' as const, raw: { id: 'x', txHash, logIndex: 3, blockNumber: '900', curveAddress: token } };
    await recordFastRows(db, chainId, [entry, entry]);
    const rows = await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash, logIndex: 3, stream: 'v2-curve', blockNumber: 900n });
    expect(rows[0]!.raw).toMatchObject({ curveAddress: token });
  });
});

describe('removeLaneTrade', () => {
  async function insertTrade(hash: string): Promise<void> {
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: 'store-venue', blockNumber: 901n, blockHash, txHash: hash, logIndex: 4, timestamp: 1_700_000_000,
      side: 'buy', tokenAmountRaw: '1', quoteAmountRaw: '2', quoteAssetAddress: token, sourceEvent: 'CurveBuy', activityKind: 'user_trade',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: token,
    });
  }
  it('deletes the trade only when the block hash matches, drops its bookkeeping and bumps the launch volume job', async () => {
    const hash = `0x${'7d'.repeat(32)}`;
    await insertTrade(hash);
    await recordFastRows(db, chainId, [{ stream: 'v2-curve', raw: { txHash: hash, logIndex: 4, blockNumber: '901' } }]);
    expect(await removeLaneTrade(db, chainId, { txHash: hash, logIndex: 4, blockHash: `0x${'00'.repeat(32)}` })).toBe(false); // a different block: not ours to remove
    expect(await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, hash)))).toHaveLength(1);
    expect(await removeLaneTrade(db, chainId, { txHash: hash.toUpperCase().replace('0X', '0x'), logIndex: 4, blockHash: blockHash.toUpperCase().replace('0X', '0x') })).toBe(true);
    expect(await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, hash)))).toHaveLength(0);
    expect(await db.select().from(fastLaneRows).where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, hash)))).toHaveLength(0);
    const job = await pool.query('SELECT revision FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    expect(job.rows[0]?.revision).toBeGreaterThanOrEqual(1);
  });
});
