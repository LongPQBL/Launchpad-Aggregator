import { createDatabase } from '../db/client.js';
import { createApiStore } from '../api/store.js';

// One-shot measurement script, not production code — no exported interface. Run against a DB
// already seeded by src/cli/generateSyntheticTrades.ts (see this file's own header comment / the
// plan's Task 11 Step 2 command for the exact two-step invocation).

const CHAIN_ID = 4663;
const CORE_QUERY_BASE = `
  SELECT l.*, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index
  FROM launches l JOIN sources s ON s.id = l.source_id
  WHERE l.chain_id = $1
`;
const CORE_QUERY_TRADES = `
  SELECT l.chain_id, l.token_address, l.quote_asset_decimals, t.quote_amount_raw, t.block_number, t.log_index, t.timestamp,
    f.feed_address, r.answer_raw, r.decimals AS price_decimals, r.updated_at AS price_updated_at
  FROM launches l
  JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
  JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
    AND t.timestamp >= $1 AND t.timestamp <= $2
  LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address AND f.verification_status = 'verified'
  LEFT JOIN LATERAL (
    SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
    WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
    ORDER BY block_number DESC, log_index DESC LIMIT 1
  ) r ON true
  WHERE l.chain_id = $3
`;

function percentile(sortedMs: readonly number[], p: number): number {
  const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, index)]!;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!process.env.VOLUME_CURSOR_SECRET) throw new Error('VOLUME_CURSOR_SECRET is required');
  const { pool } = createDatabase(databaseUrl);
  const store = createApiStore(pool);

  const launchCount = await pool.query('SELECT count(*)::int AS count FROM launches WHERE chain_id = $1', [CHAIN_ID]);
  const tradeCount = await pool.query('SELECT count(*)::int AS count FROM trades WHERE chain_id = $1', [CHAIN_ID]);
  console.log(`Benchmarking against ${launchCount.rows[0].count} launches, ${tradeCount.rows[0].count} trades (chain ${CHAIN_ID}).`);

  const durationsMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const page = await store.listLaunches({ limit: 50, chainId: CHAIN_ID, sort: 'volume24hUsd' });
    const elapsed = performance.now() - start;
    console.log(`  run ${i + 1}: ${elapsed.toFixed(1)}ms (${page.items.length} items, nextCursor=${page.nextCursor !== null})`);
    if (i > 0) durationsMs.push(elapsed); // discard the first (cold-cache) run
  }
  durationsMs.sort((a, b) => a - b);
  const p50 = percentile(durationsMs, 50);
  const p95 = percentile(durationsMs, 95);
  console.log(`\np50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=${durationsMs.length}, cold run discarded)`);

  const now = Math.floor(Date.now() / 1000);
  const since = now - 86_400;
  console.log('\n--- EXPLAIN (ANALYZE, BUFFERS) — base launch-set query ---');
  const baseExplain = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${CORE_QUERY_BASE}`, [CHAIN_ID]);
  for (const row of baseExplain.rows) console.log((row as Record<string, unknown>)['QUERY PLAN']);

  console.log('\n--- EXPLAIN (ANALYZE, BUFFERS) — 24h trades-with-price query ---');
  const tradesExplain = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${CORE_QUERY_TRADES}`, [since, now, CHAIN_ID]);
  for (const row of tradesExplain.rows) console.log((row as Record<string, unknown>)['QUERY PLAN']);

  // The spec's real gate is the frontend's 8s API timeout; treat anything over 3s as FAIL even
  // though it's technically under 8s — this is synthetic data on a dev machine, not a true
  // production load test, so the margin has to absorb that gap.
  const GATE_MS = 3000;
  const pass = p95 < GATE_MS;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}: p95=${p95.toFixed(1)}ms against gate ${GATE_MS}ms (spec's real timeout is 8000ms; this gate keeps real margin)`);

  await pool.end();
  if (!pass) process.exit(1);
}

main();
