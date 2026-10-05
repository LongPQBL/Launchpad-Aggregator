import { Pool } from 'pg';
import { refreshUsdCandles } from '../market/usdCandleStore.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const intervals = [60, 300, 900, 3600, 86400];
const fullSweepEveryMs = 15 * 60_000;
let lastFullSweepAt = 0;
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      // Every minute: launches with an official trade in the last 5 minutes. Every 15 minutes: every launch
      // with a recent trade, which also picks up trades that arrived late or were re-indexed.
      const full = Date.now() - lastFullSweepAt >= fullSweepEveryMs;
      const since = Math.floor(Date.now() / 1000) - (full ? 3 * 86_400 : 300);
      if (full) lastFullSweepAt = Date.now();
      const tokens = await pool.query(`SELECT DISTINCT l.chain_id, l.token_address FROM launches l
        JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
        JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
        WHERE t.timestamp >= $1`, [since]);
      for (const row of tokens.rows) {
        for (const interval of intervals) {
          if (stopping) break;
          await refreshUsdCandles(pool, row.chain_id, row.token_address, interval);
        }
      }
      console.log(new Date().toISOString(), full ? 'full' : 'incremental', 'refreshed', tokens.rows.length, 'launches');
    } catch (error) {
      console.error('USD candle refresh failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
} finally {
  await pool.end();
}
