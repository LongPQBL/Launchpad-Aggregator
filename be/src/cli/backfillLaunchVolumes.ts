import { Pool } from 'pg';
import { readSafeHead } from '../coverage/launchCoverageSql.js';
import { runVolumeBackfill } from '../market/launchVolume/backfill.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const result = await runVolumeBackfill(pool, {
    now: new Date(),
    batchSize: Number(process.env.LAUNCH_VOLUME_BATCH_SIZE ?? 200),
    readHead: () => readSafeHead(pool),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.complete ? 0 : 1;
} finally {
  await pool.end();
}
