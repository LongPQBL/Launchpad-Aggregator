import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './src/db/client.js';

// Runs once before any integration test file, instead of each file calling migrate() itself in its
// own beforeAll. Concurrent migrate() calls from multiple Vitest worker processes race on Postgres's
// own catalog tables (found live: "duplicate key ... pg_namespace_nspname_index", "__drizzle_migrations
// pg_type duplicate") on a fresh, not-yet-migrated database — CI always starts from one, so this is
// not a hypothetical. A single globalSetup run removes the race entirely.
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
  const { db, pool } = createDatabase(databaseUrl);
  await migrate(db, { migrationsFolder: new URL('./drizzle', import.meta.url).pathname });
  await pool.end();
}
