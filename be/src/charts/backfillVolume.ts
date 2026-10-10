import type { Pool } from 'pg';
import { markRollupBackfilled } from './rollupState.js';
import { rebuildLaunchVolume, rebuildPoolVolume } from './volumeRollup.js';

const MINUTES_PER_TRANSACTION = 500;
const BLOCKS_PER_BATCH = 50;

async function readCursor(pool: Pool, name: string): Promise<number> {
  const result = await pool.query('SELECT completed_through FROM chart_rollup_state WHERE name = $1', [name]);
  return result.rows[0] ? Number(result.rows[0].completed_through) : -1;
}

async function writeCursor(pool: Pool, name: string, value: number): Promise<void> {
  await pool.query(`INSERT INTO chart_rollup_state (name, completed_through) VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET completed_through = EXCLUDED.completed_through`, [name, value]);
}

async function inTransaction(pool: Pool, work: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Rebuilds every launch's official volume buckets from its trades, a few blocks' worth of launches at a time.
 * The cursor is the last fully processed launch block, so a stopped run resumes where it left off; every rebuild
 * is idempotent (and safe next to the live worker), so repeating work is harmless.
 */
export async function backfillLaunchVolume(pool: Pool, log: (message: string) => void = () => {}): Promise<number> {
  const name = 'launch_volume';
  let cursor = await readCursor(pool, name);
  let launches = 0;
  for (;;) {
    const blocks = await pool.query('SELECT DISTINCT launch_block FROM launches WHERE launch_block > $1 ORDER BY launch_block LIMIT $2', [cursor, BLOCKS_PER_BATCH]);
    if (blocks.rows.length === 0) break;
    const upper = Number(blocks.rows.at(-1)!.launch_block);
    const batch = await pool.query('SELECT chain_id, token_address FROM launches WHERE launch_block > $1 AND launch_block <= $2', [cursor, upper]);
    for (const launch of batch.rows) {
      const minutes = (await pool.query(`SELECT DISTINCT (t.timestamp / 60) * 60 AS bucket_start FROM trades t
        JOIN venues v ON v.id = t.venue_id AND v.official = true WHERE t.chain_id = $1 AND t.token_address = $2 ORDER BY 1`,
      [launch.chain_id, launch.token_address])).rows.map((row) => Number(row.bucket_start));
      for (const slice of chunks(minutes, MINUTES_PER_TRANSACTION)) {
        await inTransaction(pool, (client) => rebuildLaunchVolume(client, slice.map((bucketStart) => ({
          chainId: Number(launch.chain_id), tokenAddress: String(launch.token_address), bucketStart }))));
      }
      launches += 1;
    }
    cursor = upper;
    await writeCursor(pool, name, cursor);
    log(`launch volume: through launch block ${cursor} (${launches} launches)`);
  }
  await markRollupBackfilled(pool, 'launch_volume');
  return launches;
}

/** Same for pools, ordered by the block the pool was created in. */
export async function backfillPoolVolume(pool: Pool, log: (message: string) => void = () => {}): Promise<number> {
  const name = 'pool_volume';
  let cursor = await readCursor(pool, name);
  let pools = 0;
  for (;;) {
    const blocks = await pool.query('SELECT DISTINCT block_number FROM pool_catalog WHERE verified = true AND block_number > $1 ORDER BY block_number LIMIT $2', [cursor, BLOCKS_PER_BATCH]);
    if (blocks.rows.length === 0) break;
    const upper = Number(blocks.rows.at(-1)!.block_number);
    const batch = await pool.query('SELECT chain_id, protocol, pool_id FROM pool_catalog WHERE verified = true AND block_number > $1 AND block_number <= $2', [cursor, upper]);
    for (const row of batch.rows) {
      const minutes = (await pool.query(`SELECT DISTINCT (timestamp / 60) * 60 AS bucket_start FROM pool_trades
        WHERE chain_id = $1 AND protocol = $2 AND pool_id = $3 ORDER BY 1`, [row.chain_id, row.protocol, row.pool_id])).rows.map((r) => Number(r.bucket_start));
      for (const slice of chunks(minutes, MINUTES_PER_TRANSACTION)) {
        await inTransaction(pool, (client) => rebuildPoolVolume(client, slice.map((bucketStart) => ({
          chainId: Number(row.chain_id), protocol: String(row.protocol), poolId: String(row.pool_id), bucketStart }))));
      }
      pools += 1;
    }
    cursor = upper;
    await writeCursor(pool, name, cursor);
    log(`pool volume: through pool block ${cursor} (${pools} pools)`);
  }
  await markRollupBackfilled(pool, 'pool_volume');
  return pools;
}
