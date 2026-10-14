import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, trades } from '../db/schema.js';
import { runParity } from './parity.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const chainId = 996642;
const table = 'envio_fixture_parity."RawCurveTrade"';
const tables = { 'v2-curve': table };
const source = 'fast-lane-parity-test';
const token = '0x7f00000000000000000000000000000000000002';

const raw = (suffix: string, overrides: Record<string, unknown> = {}) => ({
  id: `${chainId}-b-${suffix}-1`, chainId, curveAddress: '0x7f00000000000000000000000000000000000001', side: 'buy', tokenAmountRaw: '1000', quoteAmountRaw: '2000',
  feeRaw: '0', taxRaw: '0', txFrom: '0x1111111111111111111111111111111111111111', blockNumber: '900', blockHash: `0x${'bb'.repeat(32)}`,
  txHash: `0x${suffix.repeat(32)}`, logIndex: 1, timestamp: 1_700_000_000, ...overrides,
});
/** A lane row with its trade still in `trades` (the default), or without it (`withTrade: false`: repair already removed the trade). */
async function laneRow(entry: ReturnType<typeof raw>, ageSeconds = 600, withTrade = true): Promise<void> {
  if (withTrade) {
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: 'parity-venue', blockNumber: BigInt(entry.blockNumber), blockHash: entry.blockHash, txHash: entry.txHash,
      logIndex: entry.logIndex, timestamp: entry.timestamp, side: 'buy', tokenAmountRaw: entry.tokenAmountRaw, quoteAmountRaw: entry.quoteAmountRaw,
      quoteAssetAddress: token, sourceEvent: 'CurveBuy', activityKind: 'user_trade', priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: entry.txFrom,
    });
  }
  await db.insert(fastLaneRows).values({
    chainId, txHash: entry.txHash, logIndex: entry.logIndex, stream: 'v2-curve', raw: entry, blockNumber: BigInt(entry.blockNumber),
    writtenAt: new Date(Date.now() - ageSeconds * 1000),
  });
}
async function envioRow(entry: ReturnType<typeof raw>): Promise<void> {
  await envioPool.query(`INSERT INTO ${table} (id, "chainId", "curveAddress", side, "tokenAmountRaw", "quoteAmountRaw", "feeRaw", "taxRaw", "txFrom",
    "blockNumber", "blockHash", "txHash", "logIndex", "timestamp") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [entry.id, entry.chainId, entry.curveAddress, entry.side, entry.tokenAmountRaw, entry.quoteAmountRaw, entry.feeRaw, entry.taxRaw, entry.txFrom,
    entry.blockNumber, entry.blockHash, entry.txHash, entry.logIndex, entry.timestamp]);
}
const options = { chainId, olderThanSeconds: 120, processedBlock: 1000n, tables };

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_parity');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric,
    "quoteAmountRaw" numeric, "feeRaw" numeric, "taxRaw" numeric, "txFrom" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol,
    quote_asset_decimals, lifecycle_status) VALUES ($1,$2,$3,'P','P',18,'pons','v2',$2,$2,1,$4,0,$2,'WETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'7f'.repeat(32)}`]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ('parity-venue', $1, $2, 'curve', $2, $3, 1, true) ON CONFLICT DO NOTHING`, [chainId, token, source]);
});
beforeEach(async () => {
  await envioPool.query(`TRUNCATE ${table}`);
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(trades).where(eq(trades.chainId, chainId));
});
afterAll(async () => {
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await db.delete(trades).where(eq(trades.chainId, chainId));
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await envioPool.query('DROP SCHEMA envio_fixture_parity CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('runParity', () => {
  it('counts an identical row as matching and forgets it', async () => {
    const entry = raw('a1');
    await laneRow(entry); await envioRow(entry);
    expect(await runParity(db, envioPool, options)).toMatchObject({ checked: 1, matching: 1, mismatched: [], missingInEnvio: [], pending: 0, repaired: 0 });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(0);
  });

  it('reports every field that differs, such as a wrong trader, and keeps the row', async () => {
    const entry = raw('a2');
    await laneRow(entry); await envioRow({ ...entry, txFrom: '0x2222222222222222222222222222222222222222', quoteAmountRaw: '2001' });
    const report = await runParity(db, envioPool, options);
    expect(report.matching).toBe(0);
    expect(report.mismatched).toEqual([{ txHash: entry.txHash, logIndex: 1, stream: 'v2-curve', fields: expect.arrayContaining([
      { field: 'txFrom', lane: '0x1111111111111111111111111111111111111111', envio: '0x2222222222222222222222222222222222222222' },
      { field: 'quoteAmountRaw', lane: '2000', envio: '2001' },
    ]) }]);
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(1);
  });

  it('reports an event Envio never produced, once Envio has processed that block', async () => {
    await laneRow(raw('a3'));
    expect((await runParity(db, envioPool, options)).missingInEnvio).toEqual([{ txHash: `0x${'a3'.repeat(32)}`, logIndex: 1, stream: 'v2-curve' }]);
  });

  it('leaves a row alone while it is young or beyond the block Envio has processed', async () => {
    await laneRow(raw('a4'), 5); // written 5 s ago
    await laneRow(raw('a5', { blockNumber: '1500' })); // block 1500 > processed 1000
    expect(await runParity(db, envioPool, options)).toMatchObject({ checked: 0, pending: 2, missingInEnvio: [] });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(2);
  });

  it('drops the bookkeeping of a row whose trade is already gone and counts it as repaired, not missing in Envio', async () => {
    await laneRow(raw('a6'), 600, false);
    const report = await runParity(db, envioPool, options);
    expect(report).toMatchObject({ checked: 0, repaired: 1, missingInEnvio: [] });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(0);
  });

  it('keeps a row that still has its trade but no Envio row', async () => {
    await laneRow(raw('a7'));
    expect(await runParity(db, envioPool, options)).toMatchObject({ repaired: 0, missingInEnvio: [{ txHash: `0x${'a7'.repeat(32)}` }] });
    expect(await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId))).toHaveLength(1);
  });

  it('checks the oldest rows first when the limit cuts the list', async () => {
    const newer = raw('a8'); const older = raw('a9');
    await laneRow(newer, 300); await laneRow(older, 900);
    await envioRow(newer); await envioRow(older);
    expect(await runParity(db, envioPool, { ...options, limit: 1 })).toMatchObject({ checked: 1, matching: 1 });
    const left = await db.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
    expect(left.map((row) => row.txHash)).toEqual([newer.txHash]);
  });
});
