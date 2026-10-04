import { Pool } from 'pg';
import { refreshDirtyCandles } from '../market/candleCache.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const DAY_SECONDS = 86400;

try {
  await pool.query(`INSERT INTO candle_cache_state (id, backfill_complete)
    VALUES (1, false) ON CONFLICT (id) DO UPDATE SET backfill_complete = false`);
  const bounds = await pool.query(`SELECT min(t.timestamp)::int AS oldest, max(t.timestamp)::int AS newest
    FROM trades t JOIN venues v ON v.id = t.venue_id WHERE v.official = true`);
  const oldest = bounds.rows[0]?.oldest as number | null;
  const newest = bounds.rows[0]?.newest as number | null;
  if (oldest !== null && newest !== null) {
    const progress = await pool.query('SELECT next_timestamp FROM candle_cache_state WHERE id = 1');
    let start = Math.max(oldest, Number(progress.rows[0]?.next_timestamp ?? oldest));
    start = Math.floor(start / DAY_SECONDS) * DAY_SECONDS;
    while (start <= newest) {
      const end = start + DAY_SECONDS;
      const seeded = await pool.query(`INSERT INTO candle_dirty_buckets (chain_id, token_address, bucket_start)
        SELECT DISTINCT t.chain_id, t.token_address, (t.timestamp / 60) * 60
        FROM trades t JOIN venues v ON v.id = t.venue_id AND v.official = true
        WHERE t.timestamp >= $1 AND t.timestamp < $2
        ON CONFLICT DO NOTHING`, [start, end]);
      let rebuilt = 0;
      for (;;) {
        const count = await refreshDirtyCandles(pool, 100);
        if (count === 0) break;
        rebuilt += count;
      }
      await pool.query('UPDATE candle_cache_state SET next_timestamp = $1 WHERE id = 1', [end]);
      console.log(`Candle backfill through ${new Date(end * 1000).toISOString()}: queued=${seeded.rowCount}, rebuilt=${rebuilt}`);
      start = end;
    }
  }
  // A live writer may enqueue another dirty key immediately after this check. That is safe:
  // cached API reads exclude dirty buckets until the regular worker rebuilds them.
  await pool.query('UPDATE candle_cache_state SET backfill_complete = true WHERE id = 1');
  console.log('Candle cache backfill complete; API may read persisted candles.');
} finally {
  await pool.end();
}
