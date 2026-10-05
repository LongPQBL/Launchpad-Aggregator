import { Pool } from 'pg';
import { refreshDueLaunchVolumes, sweepLaunchVolumes } from '../market/launchVolume/worker.js';
import { recordVolumeWorkerHeartbeat } from '../market/launchVolume/state.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const batchSize = Number(process.env.LAUNCH_VOLUME_BATCH_SIZE ?? 50);
const sweepEveryMs = 60_000;
let stopping = false;
let lastSweepAt = 0;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    const now = new Date();
    try {
      await recordVolumeWorkerHeartbeat(pool, now);
      if (now.getTime() - lastSweepAt >= sweepEveryMs) {
        await sweepLaunchVolumes(pool, now);
        lastSweepAt = now.getTime();
      }
      const report = await refreshDueLaunchVolumes(pool, now, batchSize);
      if (report.claimed > 0) continue;
    } catch (error) {
      console.error('Launch volume refresh failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await pool.end();
}
