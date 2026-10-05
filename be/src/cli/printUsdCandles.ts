import { Pool } from 'pg';
import { valueTradeUsd } from '../market/quotePricing/tradeValuation.js';
import { buildUsdCandles, type UsdPricedTrade } from '../market/usdCandles.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const [tokenAddress, intervalArg] = process.argv.slice(2);
if (!tokenAddress) throw new Error('usage: printUsdCandles <tokenAddress> [intervalSeconds]');
const intervalSeconds = Number(intervalArg ?? 3600);
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const launch = (await pool.query(`SELECT l.quote_asset_address, l.quote_asset_decimals, l.token_decimals
    FROM launches l WHERE l.chain_id = 4663 AND l.token_address = $1`, [tokenAddress.toLowerCase()])).rows[0];
  if (!launch) throw new Error('launch not found');
  const rows = (await pool.query(`SELECT t.timestamp, t.block_number, t.log_index, t.token_amount_raw, t.quote_amount_raw
    FROM trades t JOIN venues v ON v.id = t.venue_id AND v.official = true
    WHERE t.chain_id = 4663 AND t.token_address = $1 ORDER BY t.block_number, t.log_index`, [tokenAddress.toLowerCase()])).rows;
  const priced: UsdPricedTrade[] = [];
  let unpriced = 0;
  for (const row of rows) {
    const valuation = await valueTradeUsd(pool, 4663, launch.quote_asset_address, {
      timestamp: Number(row.timestamp), quoteAmountRaw: BigInt(row.quote_amount_raw),
      quoteAssetDecimals: launch.quote_asset_decimals, blockNumber: BigInt(row.block_number), logIndex: row.log_index,
    });
    if (valuation.status !== 'priced' || launch.token_decimals === null) { unpriced += 1; priced.push({ timestamp: Number(row.timestamp), blockNumber: BigInt(row.block_number), logIndex: row.log_index, tokenAmountRaw: BigInt(row.token_amount_raw), tokenDecimals: launch.token_decimals ?? 18, usdValue: null }); continue; }
    priced.push({ timestamp: Number(row.timestamp), blockNumber: BigInt(row.block_number), logIndex: row.log_index, tokenAmountRaw: BigInt(row.token_amount_raw), tokenDecimals: launch.token_decimals, usdValue: valuation.usdValue });
  }
  console.log(JSON.stringify({ trades: rows.length, unpriced, candles: buildUsdCandles(priced, intervalSeconds) }, null, 2));
} finally {
  await pool.end();
}
