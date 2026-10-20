import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { sources } from '../db/schema.js';
import { ensurePonsSources } from './ensureSources.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const ids = ['pons-v1-legacy', 'pons-v1-active', 'pons-v2', 'pons-v1-legacy-trades', 'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];

// Other tests' rows may reference these sources, so they are left in place.
afterAll(async () => { await pool.end(); });

describe('ensurePonsSources', () => {
  it('makes sure every static source exists, and leaves an existing one untouched', async () => {
    const before = await db.select().from(sources).where(inArray(sources.id, ids));
    await ensurePonsSources(db, 4663, 80_000_000n);
    await ensurePonsSources(db, 4663, 80_000_000n);
    const rows = await db.select().from(sources).where(inArray(sources.id, ids));
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    for (const old of before) expect(rows.find((row) => row.id === old.id)).toEqual(old);
  });
});
