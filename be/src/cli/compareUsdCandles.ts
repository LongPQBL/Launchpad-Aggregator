import { Pool } from 'pg';
import { rebuildLaunchHistory } from '../charts/backfillVolume.js';
import { rebuildUsdCandles } from '../charts/usdCandleRollup.js';

// Parity report: for the launches with the most USD candles, rebuild the new rollup from their trades and compare every
// bucket with the old usd_candles rows (skipping buckets the old table leaves out, and the legacy 15-minute interval).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const launchesArg = process.argv.indexOf('--launches');
const limit = launchesArg === -1 ? 20 : Number(process.argv[launchesArg + 1]);
if (!Number.isInteger(limit) || limit < 1) throw new Error('--launches must be a positive integer');

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
let compared = 0;
let missing = 0;
let mismatched = 0;
try {
  const launches = (await pool.query(`SELECT chain_id, token_address FROM usd_candles WHERE interval_seconds = 60
    GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT $1`, [limit])).rows;
  for (const launch of launches) {
    const chainId = Number(launch.chain_id);
    const token = String(launch.token_address);
    await rebuildLaunchHistory(pool, chainId, token, rebuildUsdCandles);
    const result = await pool.query(`SELECT o.interval_seconds, o.bucket_start, o.open AS oo, o.high AS oh, o.low AS ol, o.close AS oc, o.volume_usd AS ov,
        n.open AS no, n.high AS nh, n.low AS nl, n.close AS nc, n.volume_usd AS nv, n.unpriced_count AS nu
      FROM usd_candles o LEFT JOIN launch_usd_candle_buckets n ON n.chain_id = o.chain_id AND n.token_address = o.token_address
        AND n.interval_seconds = o.interval_seconds AND n.bucket_start = o.bucket_start
      WHERE o.chain_id = $1 AND o.token_address = $2 AND o.interval_seconds <> 900`, [chainId, token]);
    for (const row of result.rows) {
      compared += 1;
      if (row.nv === null) { missing += 1; console.log(`MISSING ${token} ${row.interval_seconds}s @${row.bucket_start}`); continue; }
      const same = Number(row.nu) === 0
        && close(Number(row.oo), Number(row.no), 1e-12) && close(Number(row.oh), Number(row.nh), 1e-12)
        && close(Number(row.ol), Number(row.nl), 1e-12) && close(Number(row.oc), Number(row.nc), 1e-12)
        && close(Number(row.ov), Number(row.nv), 1e-6);
      if (!same) { mismatched += 1; console.log(`DIFF ${token} ${row.interval_seconds}s @${row.bucket_start} old=${row.oo}/${row.oh}/${row.ol}/${row.oc}/${row.ov} new=${row.no}/${row.nh}/${row.nl}/${row.nc}/${row.nv} unpriced=${row.nu}`); }
    }
    console.log(`checked ${token}`);
  }
  console.log(`launches=${launches.length} compared=${compared} missing=${missing} mismatched=${mismatched}`);
  process.exitCode = missing + mismatched > 0 ? 1 : 0;
} finally { await pool.end(); }
