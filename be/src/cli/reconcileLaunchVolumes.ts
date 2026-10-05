import { Pool } from 'pg';
import { reconcileLaunchVolumes } from '../market/launchVolume/backfill.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const report = await reconcileLaunchVolumes(pool, {
    sampleSize: Number(process.env.LAUNCH_VOLUME_RECONCILE_SAMPLE ?? 200),
    now: new Date(),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.mismatches.length === 0 ? 0 : 1;
} finally {
  await pool.end();
}
