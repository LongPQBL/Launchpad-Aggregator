import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Database = ReturnType<typeof createDatabase>['db'];
// The callback parameter type of Database['transaction'] — structurally a query-builder like
// Database but missing $client, so it needs its own type for functions that must work both as a
// plain call and inside appDb.transaction(async (tx) => ...) for atomicity (e.g. reorgGuard.ts).
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
