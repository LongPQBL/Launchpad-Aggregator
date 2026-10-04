import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const fixtureSchema = 'metadata_state_fixture';

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${fixtureSchema}`);
  await pool.query(`CREATE TABLE ${fixtureSchema}.launches (
    chain_id integer NOT NULL, token_address text NOT NULL, source_id text NOT NULL, platform text NOT NULL,
    launch_block bigint NOT NULL, logo_uri text, description text, website_url text,
    twitter_url text, launch_timestamp integer, PRIMARY KEY (chain_id, token_address)
  )`);
  await pool.query(`INSERT INTO ${fixtureSchema}.launches
    (chain_id, token_address, source_id, platform, launch_block, logo_uri, description, website_url, twitter_url, launch_timestamp)
    VALUES
    (4663, '0xold-a', 'pons-v1-active', 'pons', 1, 'ipfs://logo', 'Real description', NULL, 'https://x.com/a', 1700000000),
    (4663, '0xold-b', 'pons-v2', 'pons', 2, NULL, NULL, NULL, NULL, NULL)`);
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE`);
  await pool.end();
});

it('migrates old null values to pending, preserves known values as done, and defaults new rows to pending', async () => {
  const migrationName = readdirSync(new URL('../../drizzle/', import.meta.url)).find((name) => /^0020_.*\.sql$/.test(name));
  expect(migrationName).toBeDefined();
  const migration = readFileSync(new URL(`../../drizzle/${migrationName}`, import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${fixtureSchema}`);
    for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
      await client.query(statement);
    }
    const old = await client.query(`SELECT token_address, logo_read_state, description_read_state,
      socials_read_state, timestamp_read_state FROM launches ORDER BY token_address`);
    expect(old.rows).toEqual([
      { token_address: '0xold-a', logo_read_state: 'done', description_read_state: 'done', socials_read_state: 'done', timestamp_read_state: 'done' },
      { token_address: '0xold-b', logo_read_state: 'pending', description_read_state: 'pending', socials_read_state: 'pending', timestamp_read_state: 'pending' },
    ]);
    await client.query(`INSERT INTO launches (chain_id, token_address, source_id, platform, launch_block)
      VALUES (4663, '0xnew', 'pons-v2', 'pons', 3)`);
    const fresh = await client.query(`SELECT logo_read_state, description_read_state, socials_read_state,
      timestamp_read_state FROM launches WHERE token_address='0xnew'`);
    expect(fresh.rows[0]).toEqual({ logo_read_state: 'pending', description_read_state: 'pending', socials_read_state: 'pending', timestamp_read_state: 'pending' });
    const budget = await client.query('SELECT last_started_at FROM metadata_enrichment_budget');
    expect(budget.rowCount).toBe(1);
    expect(budget.rows[0].last_started_at).toBeNull();
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
