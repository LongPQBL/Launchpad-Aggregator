import { Pool } from 'pg';
import { refreshDirtyPoolCandles } from '../pools/candleCache.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      const count = await refreshDirtyPoolCandles(pool, 100);
      if (count > 0) continue;
    } catch (error) {
      console.error('Pool candle refresh failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally { await pool.end(); }
