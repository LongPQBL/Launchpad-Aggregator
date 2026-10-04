import { writeFileSync } from 'node:fs';
import { createDatabase } from '../db/client.js';
import { renderV4PoolWhitelistModule } from '../indexer/v4PoolWhitelist.js';

const CHAIN_ID = 4663;
const OUTPUT_PATH = new URL('../../../envio/src/knownPonsV4PoolIds.generated.ts', import.meta.url);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to export the V4 pool whitelist');
const { pool } = createDatabase(databaseUrl);

try {
  const result = await pool.query<{ ref: string }>(
    `SELECT ref FROM venues WHERE chain_id = $1 AND kind = 'v4_pool' AND official = true ORDER BY ref`,
    [CHAIN_ID],
  );
  const poolIds = result.rows.map((row) => row.ref);
  writeFileSync(OUTPUT_PATH, renderV4PoolWhitelistModule(poolIds));
  process.stdout.write(`Wrote ${poolIds.length} known Pons V4 pool ID(s) to ${OUTPUT_PATH.pathname}\n`);
} finally {
  await pool.end();
}
