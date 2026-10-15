import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ensurePeggedRounds, PEG_DISCOVERY_SOURCE } from './peggedAssets.js';
import { __resetUsdPriceCacheForTests, readUsdPrice, readUsdPriceAtBlock } from '../usdPricing.js';
import { valueTradeUsd } from './tradeValuation.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 99_001; // private chain id: no other test file touches it
const stable = '0x5757575757575757575757575757575757575757';
const real = '0x5858585858585858585858585858585858585858';
const assets = [{ chainId, address: stable, symbol: 'STB' }, { chainId, address: real, symbol: 'REAL' }];
const HOUR = 3_600;
const t0 = 1_900_000_000 - (1_900_000_000 % HOUR); // an hour boundary
const now = new Date((t0 + 5 * HOUR + 600) * 1000);
const fakeClient = { readContract: async () => { throw new Error('a pegged asset must not read the chain'); }, chain: undefined };

async function addSwap(txDigit: string, block: number, timestamp: number) {
  await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,timestamp,amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
    VALUES ($1,$2,0,'uniswap_v4',$3,$4,$5,$6,'1','1','1',$7,$7,0) ON CONFLICT DO NOTHING`,
  [chainId, `0x${txDigit.repeat(64)}`, `0x${'9'.repeat(64)}`, block, `0x${'8'.repeat(64)}`, timestamp, stable]);
}

async function clean() {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_trades WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_catalog WHERE chain_id = $1', [chainId]);
}
beforeAll(async () => {
  await clean();
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,1,$6,$6,0,true,'caught_up')`,
  [chainId, `0x${'9'.repeat(64)}`, stable, real, `0x${'0'.repeat(40)}`, `0x${'7'.repeat(64)}`]);
  await addSwap('1', 1_000, t0 + 100); // hour 0
  await addSwap('2', 1_400, t0 + 2 * HOUR + 50); // hour 2
  await addSwap('3', 1_900, t0 + 4 * HOUR + 10); // hour 4
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'directory', 'verified', now())`, [chainId, real, `0x${'a'.repeat(40)}`]);
  __resetUsdPriceCacheForTests();
});
afterAll(async () => { await clean(); await pool.end(); });

describe('ensurePeggedRounds', () => {
  it('writes one $1.00 round per hour, each at the lowest block of any trade at or after its hour', async () => {
    const written = await ensurePeggedRounds(pool, chainId, now, { backfillDays: 1, assets });
    expect(written).toBe(25); // an hour at a time, from a day before to the hour of now (t0 + 5h)
    const rows = (await pool.query(`SELECT updated_at::bigint AS updated_at, block_number::bigint AS block, answer_raw, decimals FROM quote_usd_price_rounds
      WHERE chain_id = $1 AND feed_address = $2 ORDER BY updated_at`, [chainId, stable])).rows;
    expect(rows.every((row) => row.answer_raw === '100000000' && row.decimals === 8)).toBe(true);
    const at = (hour: number) => Number(rows.find((row) => Number(row.updated_at) === t0 + hour * HOUR)!.block);
    expect(at(0)).toBe(1_000); // the first trade is in this hour
    expect(at(1)).toBe(1_400); // the next trade at or after hour 1 is in hour 2
    expect(at(3)).toBe(1_900);
    expect(at(5)).toBe(1_900); // no trade at or after: the newest known block
    expect(rows.every((row, index) => index === 0 || Number(row.block) >= Number(rows[index - 1]!.block))).toBe(true);
  });

  it('marks the feed as a peg, is idempotent, and only adds the hours that passed since', async () => {
    const feed = (await pool.query('SELECT discovery_source, verification_status FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, stable])).rows[0];
    expect(feed).toEqual({ discovery_source: PEG_DISCOVERY_SOURCE, verification_status: 'verified' });
    expect(await ensurePeggedRounds(pool, chainId, now, { assets })).toBe(0);
    expect(await ensurePeggedRounds(pool, chainId, new Date(now.getTime() + 2 * HOUR * 1000), { assets })).toBe(2);
  });

  it('never overwrites an asset that has a real oracle feed', async () => {
    expect(await ensurePeggedRounds(pool, chainId, now, { assets: [assets[1]!] })).toBe(0);
    const feed = (await pool.query('SELECT discovery_source FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, real])).rows[0];
    expect(feed.discovery_source).toBe('directory');
  });

  it('is priced as exactly $1 by the current and the at-a-block readers, without reading the chain', async () => {
    expect(await readUsdPrice(pool, fakeClient as never, chainId, stable)).toMatchObject({ priceUsd: 1, source: 'peg' });
    expect(await readUsdPriceAtBlock(pool, fakeClient as never, chainId, stable, 1_500n, t0 + 3 * HOUR)).toBe(1);
  });

  it('values a trade in the pegged asset through the rounds like any other quote asset', async () => {
    const result = await valueTradeUsd(pool, chainId, stable, { timestamp: t0 + 2 * HOUR + 60, quoteAmountRaw: 2_500_000n, quoteAssetDecimals: 6, blockNumber: 1_450n, logIndex: 0 });
    expect(result).toEqual({ status: 'priced', usdValue: '2.5' });
  });
});
