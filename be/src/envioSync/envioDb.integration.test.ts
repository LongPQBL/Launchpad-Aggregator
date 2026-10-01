import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { envioChainProgress } from '../db/schema.js';
import { recordEnvioChainProgress } from './envioDb.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

afterAll(async () => {
  await db.delete(envioChainProgress).where(eq(envioChainProgress.chainId, 4663));
  await pool.end();
});

describe('recordEnvioChainProgress', () => {
  it('inserts on first call and updates on subsequent calls (final review, Important 3)', async () => {
    await db.delete(envioChainProgress).where(eq(envioChainProgress.chainId, 4663));
    await recordEnvioChainProgress(db, 4663, 100n);
    const [first] = await db.select().from(envioChainProgress).where(eq(envioChainProgress.chainId, 4663));
    expect(first.headBlock).toBe(100n);

    await recordEnvioChainProgress(db, 4663, 200n);
    const rows = await db.select().from(envioChainProgress).where(eq(envioChainProgress.chainId, 4663));
    expect(rows).toHaveLength(1);
    expect(rows[0].headBlock).toBe(200n);
  });
});
