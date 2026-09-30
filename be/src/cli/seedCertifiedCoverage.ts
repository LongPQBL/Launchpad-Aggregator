import { createDatabase } from '../db/client.js';
import { createRepository } from '../db/repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to seed certified coverage');
const { db, pool } = createDatabase(databaseUrl);
try {
  await createRepository(db).seedCertifiedCoverageFromCursors();
  console.log('Certified coverage seeded from existing cursors');
} finally {
  await pool.end();
}
