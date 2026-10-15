import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { __resetCurvePricingBackoffForTests, applyCurvePricingOnce } from './curvePricing.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const envioPool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'curve-pricing-test-src';
const token = `0x${'c1'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const curve = `0x${'c2'.repeat(20)}`;
const venueId = 'curve-pricing-test-venue';
const totalSupply = 1000n;
const hash = (c: string) => `0x${c.repeat(64)}`;

const tables = { rawCurveTradeTable: 'envio_fixture_curve_pricing."RawCurveTrade"', rawCurveBuybackTable: 'envio_fixture_curve_pricing."RawCurveBuyback"' };
// A contract without the function: viem reports a revert / empty answer, which the pricing treats as "this curve has no such figure".
class AbsentFunction extends Error { override name = 'ContractFunctionZeroDataError'; }
function clientWith(state: Partial<Record<'quoteReserve' | 'tokenReserve' | 'realQuoteReserve', (blockNumber: bigint) => bigint>>) {
  return { readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
    if (functionName === 'totalSupply') return totalSupply;
    const read = state[functionName as keyof typeof state];
    if (read) return read(blockNumber ?? 0n);
    throw new AbsentFunction(functionName);
  } };
}
const rpcClient = clientWith({}); // a curve with no virtual reserve and no way to check its reserves

async function addTrade(txHash: string, logIndex: number, blockNumber: number, sourceEvent: 'CurveBuy' | 'CurveSell', side: 'buy' | 'sell',
  tokenAmountRaw: bigint, quoteAmountRaw: bigint, feeRaw: bigint, taxRaw: bigint) {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'user_trade',$2)`,
  [chainId, token, venueId, blockNumber, hash('a'), txHash, logIndex, 1_700_000_000, side, tokenAmountRaw.toString(), quoteAmountRaw.toString(), quote, sourceEvent]);
  await envioPool.query(`INSERT INTO ${tables.rawCurveTradeTable} (id, "chainId", "txHash", "logIndex", "feeRaw", "taxRaw") VALUES ($1,$2,$3,$4,$5,$6)`,
    [`${txHash}-${logIndex}`, chainId, txHash, logIndex, feeRaw.toString(), taxRaw.toString()]);
}

async function addLaneTrade(txHash: string, logIndex: number, blockNumber: number, tokenAmountRaw: bigint, quoteAmountRaw: bigint, feeRaw = 0n, taxRaw = 0n) {
  // A trade the fast lane wrote: in `trades`, but Envio has no raw row for it yet.
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'buy',$9,$10,$11,'CurveBuy','user_trade',$2)`,
  [chainId, token, venueId, blockNumber, hash('a'), txHash, logIndex, 1_700_000_000, tokenAmountRaw.toString(), quoteAmountRaw.toString(), quote]);
  await pool.query(`INSERT INTO fast_lane_rows (chain_id, tx_hash, log_index, stream, raw, block_number) VALUES ($1,$2,$3,'v2-curve',$5,$4)`,
    [chainId, txHash, logIndex, blockNumber, JSON.stringify({ feeRaw: feeRaw.toString(), taxRaw: taxRaw.toString() })]);
}

async function addRawRow(txHash: string, logIndex: number, feeRaw: bigint, taxRaw: bigint) {
  await envioPool.query(`INSERT INTO ${tables.rawCurveTradeTable} (id, "chainId", "txHash", "logIndex", "feeRaw", "taxRaw") VALUES ($1,$2,$3,$4,$5,$6)`,
    [`${txHash}-${logIndex}`, chainId, txHash, logIndex, feeRaw.toString(), taxRaw.toString()]);
}

async function addBuyback(txHash: string, logIndex: number, blockNumber: number, tokensLockedRaw: bigint, quoteSpentRaw: bigint) {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'buy',$9,$10,$11,'BuybackLocked','protocol_buyback',$2)`,
  [chainId, token, venueId, blockNumber, hash('a'), txHash, logIndex, 1_700_000_000, tokensLockedRaw.toString(), quoteSpentRaw.toString(), quote]);
}

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_curve_pricing');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables.rawCurveTradeTable} (id text primary key,
    "chainId" int, "txHash" text, "logIndex" int, "feeRaw" numeric, "taxRaw" numeric)`);
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'c3'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'Curve Pricing', 'CVP', 0, 'pons', 'v2', $2, $2, 1, $4, 0, $5, 'ETH', 0, 'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'c4'.repeat(32)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'curve', $4, $5, 1, true) ON CONFLICT DO NOTHING`, [venueId, chainId, token, curve, source]);
});

beforeEach(async () => {
  __resetCurvePricingBackoffForTests();
  await pool.query('DELETE FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM fast_lane_rows WHERE chain_id = $1', [chainId]);
  await envioPool.query(`DELETE FROM ${tables.rawCurveTradeTable} WHERE "chainId" = $1`, [chainId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM fast_lane_rows WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM venues WHERE id = $1', [venueId]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await envioPool.query('DROP SCHEMA envio_fixture_curve_pricing CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('applyCurvePricingOnce', () => {
  it('anchors a fresh launch at {quote:0, token:totalSupply} and replays buy, sell, and buyback in order', async () => {
    await addTrade(hash('1'), 1, 100, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    await addTrade(hash('2'), 2, 101, 'CurveSell', 'sell', 50n, 40n, 2n, 1n);
    await addBuyback(hash('3'), 0, 102, 5n, 10n);

    const report = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    expect(report.processed).toBe(1);
    expect(report.pricedTrades).toBe(3);

    const rows = (await pool.query(
      `SELECT log_index, price_numerator_raw, price_denominator_raw FROM trades
       WHERE chain_id = $1 AND token_address = $2 ORDER BY block_number, log_index`, [chainId, token])).rows;
    expect(rows.map((row) => ({ logIndex: row.log_index, num: row.price_numerator_raw, den: row.price_denominator_raw }))).toEqual([
      { logIndex: 1, num: '98', den: '910' },
      { logIndex: 2, num: '55', den: '960' },
      { logIndex: 0, num: '65', den: '955' },
    ]);

    const checkpoint = (await pool.query(
      `SELECT quote_reserve_raw, token_reserve_raw, last_block_number, last_log_index FROM launch_curve_reserves
       WHERE chain_id = $1 AND token_address = $2`, [chainId, token])).rows[0];
    expect(checkpoint).toMatchObject({ quote_reserve_raw: '65', token_reserve_raw: '955', last_block_number: '102', last_log_index: 0 });
  });

  it('is idempotent: a second run with no new trades leaves prices and the checkpoint unchanged', async () => {
    await addTrade(hash('4'), 1, 200, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    const again = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    expect(again.processed).toBe(0);
  });

  it('only replays trades after the checkpoint, not the whole history, on a later tick', async () => {
    await addTrade(hash('5'), 1, 300, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    await addTrade(hash('6'), 2, 301, 'CurveSell', 'sell', 50n, 40n, 2n, 1n);
    const second = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    expect(second.pricedTrades).toBe(1);
    const row = (await pool.query(
      `SELECT price_numerator_raw, price_denominator_raw FROM trades WHERE chain_id = $1 AND tx_hash = $2`, [chainId, hash('6')])).rows[0];
    expect(row).toEqual({ price_numerator_raw: '55', price_denominator_raw: '960' });
  });

  it('still finds a new trade right after a tick that found nothing, through the newest trades, without rescanning every launch', async () => {
    await addTrade(hash('7'), 1, 400, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    const empty = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables); // nothing due: the full scan is now throttled
    expect(empty.processed).toBe(0);
    await addTrade(hash('8'), 2, 401, 'CurveSell', 'sell', 50n, 40n, 2n, 1n);
    const next = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    expect(next.pricedTrades).toBe(1);
  });

  it('backs off a launch whose replay fails so it stops occupying a batch slot, then retries it later', async () => {
    // A priced-behind trade with no matching Envio raw row cannot be replayed.
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1,$2,$3,400,$4,$5,1,1700000000,'buy','90','100',$6,'CurveBuy','user_trade',$2)`,
    [chainId, token, venueId, hash('a'), hash('7'), quote]);
    const start = new Date();

    const first = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, start, tables);
    expect(first).toMatchObject({ processed: 1, pricedTrades: 0, failed: 1 });

    const during = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(start.getTime() + 1_000), tables);
    expect(during.processed).toBe(0);

    const after = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(start.getTime() + 61_000), tables);
    expect(after.processed).toBe(1);
  });

  it('prices a trade the lane wrote at once, from the fee and tax the lane recorded, with the same result as Envio\'s row', async () => {
    await addTrade(hash('8'), 1, 500, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    await addLaneTrade(hash('9'), 1, 502, 50n, 60n, 2n, 1n); // no Envio raw row for this one
    const report = await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    expect(report).toMatchObject({ pricedTrades: 2, failed: 0 });
    const lanePrice = (await pool.query(`SELECT price_numerator_raw FROM trades WHERE chain_id = $1 AND tx_hash = $2`, [chainId, hash('9')])).rows[0];
    expect(lanePrice.price_numerator_raw).not.toBeNull();

    // The same launch replayed with Envio's row for the second trade gives the same prices.
    const before = (await pool.query(`SELECT tx_hash, price_numerator_raw, price_denominator_raw FROM trades WHERE chain_id = $1 AND token_address = $2 ORDER BY block_number`, [chainId, token])).rows;
    await addRawRow(hash('9'), 1, 2n, 1n);
    await pool.query('DELETE FROM fast_lane_rows WHERE chain_id = $1', [chainId]);
    await pool.query('DELETE FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables);
    const after = (await pool.query(`SELECT tx_hash, price_numerator_raw, price_denominator_raw FROM trades WHERE chain_id = $1 AND token_address = $2 ORDER BY block_number`, [chainId, token])).rows;
    expect(after).toEqual(before);
  });

  it('a trade with neither an Envio raw row nor a lane record is still a failure that backs off', async () => {
    await addTrade(hash('b'), 1, 600, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1,$2,$3,601,$4,$5,1,1700000000,'buy','5','6',$6,'CurveBuy','user_trade',$2)`, [chainId, token, venueId, hash('a'), hash('c'), quote]);
    expect(await applyCurvePricingOnce(pool, envioPool, rpcClient as never, 10, new Date(), tables)).toMatchObject({ failed: 1 });
  });

  it('starts from the curve\'s virtual quote reserve read at the launch block, so a curve that starts with one is priced from the right reserves', async () => {
    await addTrade(hash('v1'), 1, 900, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    const client = clientWith({ quoteReserve: () => 50n, realQuoteReserve: () => 0n }); // virtual quote 50, no tokenReserve: not checked
    await applyCurvePricingOnce(pool, envioPool, client as never, 10, new Date(), tables);
    const row = (await pool.query('SELECT price_numerator_raw, price_denominator_raw FROM trades WHERE chain_id = $1 AND tx_hash = $2', [chainId, hash('v1')])).rows[0];
    expect(row).toEqual({ price_numerator_raw: '148', price_denominator_raw: '910' }); // 50 + 98 over 910, not 98 over 910
  });

  it('writes no price when the replay does not end where the chain says the curve was (a missing trade), and prices it once it does', async () => {
    await addTrade(hash('v2'), 1, 950, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    const wrong = clientWith({ quoteReserve: () => 5_000n, tokenReserve: () => 910n });
    const first = await applyCurvePricingOnce(pool, envioPool, wrong as never, 10, new Date(), tables);
    expect(first).toMatchObject({ pricedTrades: 0, failed: 1 });
    expect((await pool.query('SELECT price_numerator_raw FROM trades WHERE chain_id = $1 AND tx_hash = $2', [chainId, hash('v2')])).rows[0].price_numerator_raw).toBeNull();
    expect((await pool.query('SELECT 1 FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows).toHaveLength(0);

    __resetCurvePricingBackoffForTests();
    const right = clientWith({ quoteReserve: () => 98n, tokenReserve: () => 910n });
    expect(await applyCurvePricingOnce(pool, envioPool, right as never, 10, new Date(), tables)).toMatchObject({ pricedTrades: 1, failed: 0 });
  });

  it('treats a node error while reading the reserves as a failure, not as "no virtual reserve"', async () => {
    await addTrade(hash('v3'), 1, 960, 'CurveBuy', 'buy', 90n, 100n, 1n, 1n);
    const broken = { readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'totalSupply') return totalSupply;
      throw new Error('missing trie node');
    } };
    expect(await applyCurvePricingOnce(pool, envioPool, broken as never, 10, new Date(), tables)).toMatchObject({ pricedTrades: 0, failed: 1 });
  });
});
