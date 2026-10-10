import { Pool } from 'pg';
import { backfillLaunchVolume, backfillPoolVolume } from '../charts/backfillVolume.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const launches = await backfillLaunchVolume(pool, console.log);
  const pools = await backfillPoolVolume(pool, console.log);
  console.log(`done: ${launches} launches, ${pools} pools`);
} finally { await pool.end(); }
