import { createDatabase } from '../db/client.js';
import { estimateBackfill, type SourceProgress, type ThroughputSample } from '../indexer/backfillEstimate.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { getTradeSourceDefinitions } from '../indexer/tradeRuntime.js';
import { requiredSourceDependencies } from '../indexer/jobPlanner.js';

const CHAIN_ID = 4663;
// How far back to look for scan_jobs rows when building a throughput sample. Wide enough to smooth
// over short lulls, narrow enough to reflect current (not stale, pre-optimization) speed.
const SAMPLE_LOOKBACK_MINUTES = Number(process.env.INDEXER_STATUS_LOOKBACK_MINUTES ?? '30');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to report indexer status');
const { db, pool } = createDatabase(databaseUrl);
void db;

try {
  const [headResult, sourceRows] = await Promise.all([
    pool.query('SELECT max(number) AS safe_head FROM observed_blocks WHERE chain_id = $1', [CHAIN_ID]),
    pool.query('SELECT id, scanned_to_block, start_block FROM sources WHERE chain_id = $1', [CHAIN_ID]),
  ]);
  const safeHead = headResult.rows[0]?.safe_head === null ? null : BigInt(headResult.rows[0].safe_head);
  const registeredIds = new Set(sourceRows.rows.map((row: { id: string }) => row.id));
  const knownIds = [
    ...getPonsFactorySources().map((source) => source.id),
    'pons-v2-lifecycle',
    ...getTradeSourceDefinitions().map((definition) => definition.source.id),
  ].filter((id) => registeredIds.has(id));
  const v4Ids = [...registeredIds].filter((id) => id.startsWith('pons-v2-v4:'));
  const sourceIds = [...knownIds, ...v4Ids];

  const byId = new Map(sourceRows.rows.map((row: { id: string; scanned_to_block: string; start_block: string }) =>
    [row.id, row]));
  const sources: SourceProgress[] = sourceIds.map((id) => {
    const row = byId.get(id) as { scanned_to_block: string; start_block: string };
    return { sourceId: id, dependsOn: requiredSourceDependencies(id),
      certifiedFrontier: BigInt(row.scanned_to_block), startBlock: BigInt(row.start_block) };
  });

  const samples: ThroughputSample[] = [];
  for (const id of sourceIds) {
    const [completedResult, failedResult] = await Promise.all([
      pool.query(`SELECT from_block, to_block, elapsed_ms FROM scan_jobs
        WHERE source_id = $1 AND lane = 'certified' AND status = 'complete'
          AND completed_at >= now() - ($2 || ' minutes')::interval`, [id, SAMPLE_LOOKBACK_MINUTES]),
      pool.query(`SELECT count(*)::int AS count FROM scan_jobs
        WHERE source_id = $1 AND status = 'failed' AND error_reason ~* '429|rate limit|too many requests'
          AND lease_until >= now() - ($2 || ' minutes')::interval`, [id, SAMPLE_LOOKBACK_MINUTES]),
    ]);
    const totalBlocks = completedResult.rows.reduce((sum: bigint, row: { from_block: string; to_block: string }) =>
      sum + (BigInt(row.to_block) - BigInt(row.from_block) + 1n), 0n);
    const totalElapsedSeconds = completedResult.rows.reduce((sum: number, row: { elapsed_ms: number | null }) =>
      sum + (row.elapsed_ms ?? 0) / 1000, 0);
    if (completedResult.rows.length === 0) continue;
    samples.push({ sourceId: id, windowStartBlock: 0n, windowEndBlock: totalBlocks,
      elapsedSeconds: totalElapsedSeconds, rpc429Count: failedResult.rows[0].count });
  }

  const lifecycle = sources.find((source) => source.sourceId === 'pons-v2-lifecycle');
  const unresolvedPoolDiscovery = lifecycle ? (safeHead === null || lifecycle.certifiedFrontier < safeHead) : false;

  if (safeHead === null) {
    console.log('No observed safe head yet — indexer has not completed a cycle/pass.');
  } else {
    const result = estimateBackfill({ safeHead, sources, samples, unresolvedPoolDiscovery });
    console.log(`Safe head: ${safeHead} | sample window: last ${SAMPLE_LOOKBACK_MINUTES}m`);
    console.log('Per-source:');
    for (const estimate of result.perSource) {
      const rate = estimate.blocksPerSecondLow !== null && estimate.blocksPerSecondHigh !== null
        ? `${estimate.blocksPerSecondLow.toFixed(1)}-${estimate.blocksPerSecondHigh.toFixed(1)} blocks/s`
        : 'no reliable sample';
      console.log(`  ${estimate.sourceId}: remaining=${estimate.remainingBlocks} ${rate}`);
    }
    if (result.pipeline.reliable) {
      const low = Math.round(result.pipeline.etaSecondsLow);
      const high = Math.round(result.pipeline.etaSecondsHigh);
      console.log(`Pipeline ETA: ${low}s - ${high}s (${(low / 3600).toFixed(1)}h - ${(high / 3600).toFixed(1)}h)`);
    } else {
      console.log(`Pipeline ETA: unreliable — ${result.pipeline.reason}`);
    }
    for (const caveat of result.pipeline.caveats) console.log(`Caveat: ${caveat}`);
  }
} finally {
  await pool.end();
}
