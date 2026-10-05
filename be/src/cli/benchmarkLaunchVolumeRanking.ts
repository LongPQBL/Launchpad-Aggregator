import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { runVolumeBackfill } from '../market/launchVolume/backfill.js';
import { readVolumeRankingPage, type VolumeRankCursor } from '../market/launchVolume/ranking.js';
import { invalidateLaunchVolume } from '../market/launchVolume/store.js';
import { refreshDueLaunchVolumes } from '../market/launchVolume/worker.js';

// Disposable-database benchmark for the cached 24h volume ranking. Refuses to run on anything but a
// database whose name ends in _bench, so it cannot touch the live launchpad database.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!new URL(databaseUrl).pathname.endsWith('_bench')) throw new Error('Benchmark requires a database ending in _bench');

const LAUNCHES = Number(process.env.BENCH_LAUNCHES ?? 160_000);
const ACTIVE_LAUNCHES = Number(process.env.BENCH_ACTIVE_LAUNCHES ?? 5_000);
const TRADES_PER_ACTIVE = 36;
const TRADES_PER_OLDER = 34;
const CONCENTRATED_TRADES = 20_000;
const HEAD = 9_000_000n;
const chainId = 4663;
const source = 'bench-src';
const quote = `0x${'b0'.repeat(20)}`;
const feed = `0x${'b1'.repeat(20)}`;

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const { db, pool: drizzlePool } = createDatabase(databaseUrl);

function addr(index: number): string { return `0x${index.toString(16).padStart(40, '0')}`; }
function hash(index: number): string { return `0x${index.toString(16).padStart(64, '0')}`; }
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10;
}
function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  return fn().then((value) => ({ value, ms: performance.now() - started }));
}

// Deterministic PRNG so repeated runs produce the same shape.
let seed = 42;
function random(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

async function seedData(nowSeconds: number): Promise<{ trades: number; rounds: number }> {
  await pool.query('TRUNCATE launch_volume24h_usd, launch_volume24h_jobs, launch_volume24h_state, trades, venues, launches, quote_usd_price_rounds, quote_usd_feeds, sources, envio_chain_progress RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v1', $3, 0, $4, $4, 'caught_up'), ($1 || '-trades', $2, 'v1', $3, 0, $4, $4, 'caught_up')`,
  [source, chainId, addr(0xfffff), HEAD.toString()]);
  await pool.query('INSERT INTO envio_chain_progress (chain_id, head_block) VALUES ($1, $2)', [chainId, HEAD.toString()]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'bench', 'verified', now())`, [chainId, quote, feed]);

  const startTs = nowSeconds - 30 * 86_400;
  const roundCount = 30 * 1440;
  const roundIds: number[] = []; const roundAnswers: string[] = []; const roundTimes: number[] = []; const roundBlocks: number[] = [];
  for (let k = 0; k < roundCount; k++) {
    roundIds.push(k + 1); roundAnswers.push((150_000_000 + (k % 500) * 1000).toString()); roundTimes.push(startTs + k * 60); roundBlocks.push(1_000_000 + k * 100);
  }
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    SELECT $1, $2, r.round_id, r.answer, 8, r.t, r.t, r.b, 0 FROM unnest($3::numeric[], $4::numeric[], $5::int[], $6::bigint[]) AS r(round_id, answer, t, b)`,
  [chainId, feed, roundIds, roundAnswers, roundTimes, roundBlocks]);

  let tradeCount = 0;
  const BATCH_LAUNCHES = 5_000;
  for (let batchStart = 0; batchStart < LAUNCHES; batchStart += BATCH_LAUNCHES) {
    const launchRows: unknown[][] = [];
    const venueRows: unknown[][] = [];
    const tradeRows: unknown[][] = [];
    const pushTrade = (launchIndex: number, token: string, timestamp: number): void => {
      const round = Math.min(roundCount - 1, Math.max(0, Math.floor((timestamp - startTs) / 60)));
      const block = 1_000_000 + round * 100 + 50;
      tradeCount += 1;
      tradeRows.push([chainId, token, `bench-v-${launchIndex}`, block, hash(0xabc), hash(tradeCount + 1_000_000_000), 1, timestamp,
        tradeCount % 2 === 0 ? 'buy' : 'sell', '1000000000000000000', (2_000_000_000_000_000_000n + BigInt(tradeCount % 1000)).toString(),
        quote, 'Swap', 'user_trade', token]);
    };
    const batchEnd = Math.min(LAUNCHES, batchStart + BATCH_LAUNCHES);
    for (let i = batchStart; i < batchEnd; i++) {
      const token = addr(i + 1);
      launchRows.push([chainId, token, source, `Bench ${i}`, `B${i}`, 18, 'pons', 'v1', token, token, 1_000_000 + i,
        hash(i + 1), 1, quote, 'WETH', 18, 'trading']);
      venueRows.push([`bench-v-${i}`, chainId, token, 'v3_pool', token, source, 1]);
      if (i < ACTIVE_LAUNCHES) {
        const count = i === 0 ? CONCENTRATED_TRADES : TRADES_PER_ACTIVE;
        for (let j = 0; j < count; j++) pushTrade(i, token, nowSeconds - 86_000 + Math.floor((j * 85_000) / count));
      } else {
        for (let j = 0; j < TRADES_PER_OLDER; j++) pushTrade(i, token, startTs + Math.floor(random() * (30 * 86_400 - 86_401)));
      }
    }
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
      factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[],
        $11::bigint[], $12::text[], $13::int[], $14::text[], $15::text[], $16::int[], $17::text[])`,
    transpose(launchRows, 17));
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      SELECT v.id, v.chain_id, v.token, v.kind, v.ref, v.src, v.eff, true FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[]) AS v(id, chain_id, token, kind, ref, src, eff)`,
    transpose(venueRows, 7));
    for (let offset = 0; offset < tradeRows.length; offset += 50_000) {
      await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
        side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
        SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::int[], $8::int[],
          $9::text[], $10::numeric[], $11::numeric[], $12::text[], $13::text[], $14::text[], $15::text[])`,
      transpose(tradeRows.slice(offset, offset + 50_000), 15));
    }
  }
  return { trades: tradeCount, rounds: roundCount };
}

// Column-major arrays for unnest(): one bind parameter per column, regardless of row count.
function transpose(rows: unknown[][], columns: number): unknown[][] {
  return Array.from({ length: columns }, (_, column) => rows.map((row) => row[column]));
}

async function main(): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const now = new Date(nowSeconds * 1000);
  const report: Record<string, unknown> = { launches: LAUNCHES, activeLaunches: ACTIVE_LAUNCHES, concentratedTrades: CONCENTRATED_TRADES };

  const seeded = await timed(() => seedData(nowSeconds));
  report.seed = { ms: Math.round(seeded.ms), trades: seeded.value.trades, rounds: seeded.value.rounds };

  const backfill = await timed(() => runVolumeBackfill(pool, { now, batchSize: 500, readHead: async () => HEAD }));
  report.backfill = { ms: Math.round(backfill.ms), complete: backfill.value.complete, iterations: backfill.value.iterations, published: backfill.value.published, failed: backfill.value.failed };

  const warm: number[] = [];
  for (let run = 0; run < 30; run++) warm.push((await timed(() => readVolumeRankingPage(pool, { cursor: null, limit: 50, headBlock: HEAD }))).ms);
  report.firstPageWarm = { p50: percentile(warm, 50), p95: percentile(warm, 95) };

  const cold = await timed(() => {
    const coldPool = new Pool({ connectionString: databaseUrl, max: 1 });
    return readVolumeRankingPage(coldPool, { cursor: null, limit: 50, headBlock: HEAD }).finally(() => coldPool.end());
  });
  report.firstPageNewConnection = { ms: Math.round(cold.ms * 10) / 10 };

  const later: number[] = [];
  let cursor: VolumeRankCursor | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await timed(() => readVolumeRankingPage(pool, { cursor, limit: 50, headBlock: HEAD }));
    later.push(result.ms);
    cursor = result.value.nextCursor;
    if (!cursor) break;
  }
  report.laterPagesWalked = { pages: later.length, p95: percentile(later, 95) };

  const filtered: number[] = [];
  for (let run = 0; run < 30; run++) {
    filtered.push((await timed(() => readVolumeRankingPage(pool, { chainId, search: 'Bench 1', cursor: null, limit: 50, headBlock: HEAD }))).ms);
  }
  report.filteredSearchWarm = { p50: percentile(filtered, 50), p95: percentile(filtered, 95) };

  const concurrent = await timed(() => Promise.all(Array.from({ length: 8 }, () =>
    timed(() => readVolumeRankingPage(pool, { cursor: null, limit: 50, headBlock: HEAD })))));
  report.concurrentFirstPages = { requests: 8, wallMs: Math.round(concurrent.ms), p95Each: percentile(concurrent.value.map((item) => item.ms), 95) };

  const publish: number[] = [];
  for (let sample = 0; sample < 20; sample++) {
    const token = addr(sample + 1);
    const invalidatedAt = performance.now();
    await invalidateLaunchVolume(db, [{ chainId, tokenAddress: token }], new Date());
    await refreshDueLaunchVolumes(pool, new Date(), 1, async () => HEAD);
    publish.push(performance.now() - invalidatedAt);
  }
  report.invalidationToPublish = { samples: publish.length, p50: percentile(publish, 50), p95: percentile(publish, 95) };

  console.log(JSON.stringify(report, null, 2));
  await drizzlePool.end();
  await pool.end();
}

await main();
