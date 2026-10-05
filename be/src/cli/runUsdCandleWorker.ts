import { Pool } from 'pg';
import { refreshUsdCandles } from '../market/usdCandleStore.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const intervals = [60, 300, 900, 3600, 86400];
const recentSeconds = Number(process.env.USD_CANDLE_RECENT_SECONDS ?? 3 * 86_400);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      // Launches with official trades in the recent window. Older candles stay as last computed.
      const tokens = await pool.query(`SELECT DISTINCT l.chain_id, l.token_address FROM launches l
        JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
        JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
        WHERE t.timestamp >= $1`, [Math.floor(Date.now() / 1000) - recentSeconds]);
      for (const row of tokens.rows) {
        for (const interval of intervals) {
          if (stopping) break;
          await refreshUsdCandles(pool, row.chain_id, row.token_address, interval);
        }
      }
      console.log(new Date().toISOString(), 'refreshed', tokens.rows.length, 'launches');
    } catch (error) {
      console.error('USD candle refresh failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
} finally {
  await pool.end();
}
