import type { Pool } from 'pg';
import { DEFAULT_STREAM_TABLES } from './incrementalSync.js';
import { DEFAULT_ADDITIONAL_POOL_TABLES } from '../pools/syncV3V2Pools.js';

/**
 * Envio declares `@index` on its raw tables but, while it is still catching up, a database holds only the primary keys: every page the
 * sync reads then scans and sorts the whole table, and the keyset condition cannot start where the cursor is (a 5,000 row page of a
 * 100k row table took 7.7 s; 0.1 s with the index). Created here instead of by hand so any database the sync is pointed at has them.
 * `CREATE INDEX CONCURRENTLY` does not block Envio's writes; `IF NOT EXISTS` makes a restart free. A table Envio has not created yet
 * (a stream with no event so far) is skipped and picked up on the next start.
 */
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
function splitTable(table: string): { schema: string; name: string } {
  const match = /^([a-z0-9_]+)\."([A-Za-z0-9_]+)"$/.exec(table);
  if (!match) throw new Error(`Unexpected raw table identifier: ${table}`);
  return { schema: match[1]!, name: match[2]! };
}

export interface EnsureEnvioIndexesResult { created: string[]; skippedMissingTables: string[] }

/** True once Envio has created the tables the sync reads (it creates them while initializing its storage, a minute or more after its container starts). */
export async function envioTablesPresent(envioPool: Pool): Promise<boolean> {
  const result = await envioPool.query(`SELECT to_regclass('envio.chain_metadata') IS NOT NULL AND to_regclass('envio."RawLaunchV2"') IS NOT NULL AS present`);
  return result.rows[0]?.present === true;
}

/**
 * True once Envio has finished initializing its storage and has processed a first batch. Before that Envio creates, resets and re-tracks its
 * tables, and an index built CONCURRENTLY in that window is left invalid ("Ignoring invalid PostgreSQL indexes", seen on a fresh window).
 */
export async function envioStorageReady(envioPool: Pool): Promise<boolean> {
  const exists = await envioPool.query(`SELECT to_regclass('envio.envio_chains') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return false;
  const progress = await envioPool.query('SELECT max(progress_block) AS progress FROM envio.envio_chains');
  const value = progress.rows[0]?.progress;
  return value !== null && value !== undefined && BigInt(String(value)) > 0n;
}

export async function ensureEnvioReadIndexes(
  envioPool: Pool,
  tables: readonly string[] = [...new Set([...Object.values(DEFAULT_STREAM_TABLES), ...Object.values(DEFAULT_ADDITIONAL_POOL_TABLES)])],
  options: { waitForEnvio?: boolean } = {},
): Promise<EnsureEnvioIndexesResult> {
  const created: string[] = [];
  const skippedMissingTables: string[] = [];
  if ((options.waitForEnvio ?? true) && !(await envioStorageReady(envioPool))) return { created, skippedMissingTables: [...tables] };
  for (const table of tables) {
    const { schema, name } = splitTable(table);
    const exists = await envioPool.query('SELECT to_regclass($1) IS NOT NULL AS present', [`${quote(schema)}.${quote(name)}`]);
    if (!exists.rows[0]?.present) { skippedMissingTables.push(table); continue; }
    const columns = await envioPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, name]);
    const have = new Set(columns.rows.map((row: { column_name: string }) => row.column_name));
    const wanted: Array<{ suffix: string; columns: string[] }> = [];
    if (['chainId', 'blockNumber', 'logIndex', 'id'].every((column) => have.has(column))) {
      wanted.push({ suffix: 'page', columns: ['chainId', 'blockNumber', 'logIndex', 'id'] });
    }
    if (['chainId', 'txHash', 'logIndex'].every((column) => have.has(column))) {
      wanted.push({ suffix: 'tx', columns: ['chainId', 'txHash', 'logIndex'] });
    }
    for (const { suffix, columns: indexColumns } of wanted) {
      const indexName = `sync_${name.toLowerCase()}_${suffix}`;
      // A build that was cancelled leaves an invalid index that IF NOT EXISTS would keep; start over from a clean one.
      const state = await envioPool.query(
        `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`, [schema, indexName]);
      if (state.rows[0] && !state.rows[0].indisvalid) await envioPool.query(`DROP INDEX ${quote(schema)}.${quote(indexName)}`);
      if (state.rows[0]?.indisvalid) continue;
      await envioPool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quote(indexName)} ON ${quote(schema)}.${quote(name)} (${indexColumns.map(quote).join(', ')})`);
      created.push(`${schema}.${indexName}`);
    }
  }
  return { created, skippedMissingTables };
}
