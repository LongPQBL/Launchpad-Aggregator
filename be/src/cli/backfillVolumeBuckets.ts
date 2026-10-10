import { Pool } from 'pg';
import { backfillLaunchVolume, backfillPoolVolume, backfillUsdCandles } from '../charts/backfillVolume.js';

// Rebuilds the chart rollups from trades. Resumable; `--only volume` or `--only usd` runs one part (each has its own cursor).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
if (only !== null && only !== 'volume' && only !== 'usd') throw new Error('--only must be "volume" or "usd"');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  let summary = '';
  if (only !== 'usd') {
    const launches = await backfillLaunchVolume(pool, console.log);
    const pools = await backfillPoolVolume(pool, console.log);
    summary += `${launches} launches and ${pools} pools with volume`;
  }
  if (only !== 'volume') summary += `${summary ? ', ' : ''}${await backfillUsdCandles(pool, console.log)} launches with USD candles`;
  console.log(`done: ${summary}`);
} finally { await pool.end(); }
