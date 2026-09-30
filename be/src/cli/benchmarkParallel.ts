import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { createDatabase } from '../db/client.js';
import { createRepository } from '../db/repository.js';
import { createFactoryDecoder } from '../indexer/factoryRuntime.js';
import { scanToHead, type LogSource } from '../indexer/scan.js';
import { readV1Graduation, readV1TokenMetadata, type V1ReadClient } from '../launchpads/pons/v1/state.js';
import { readV2LaunchRecord, readV2TokenMetadata, resolveV2QuoteAsset, type V2ReadClient } from '../launchpads/pons/v2/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { createViemGetLogs, getFactoryLogSources } from './indexer.js';

// One-off experiment: how many independent log-only sources can run in parallel (Promise.all)
// against the real free RPC before rate-limit errors start showing up, and how much speedup
// does each step of added parallelism actually buy versus running them one at a time?
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const blocksPerPhase = BigInt(process.env.BENCH_BLOCKS ?? '500000');
const parallelism = Number(process.env.BENCH_PARALLEL ?? '3');
const { db, pool } = createDatabase(databaseUrl);
const repository = createRepository(db);
const client = createRobinhoodPublicClient(rpcUrl);
const factories = getPonsFactorySources();
const allSources = getFactoryLogSources();
const sources = allSources.slice(0, parallelism);
if (sources.length < parallelism) throw new Error(`Only ${allSources.length} factory log sources available`);
const v1Reader = client as unknown as V1ReadClient;
const v2Reader = client as unknown as V2ReadClient;
const decoder = createFactoryDecoder({
  loadV1: async (event, sourceId) => {
    const factory = factories.find((item) => item.id === sourceId);
    if (!factory) throw new Error(`Unknown factory: ${sourceId}`);
    const [metadata, graduated] = await Promise.all([
      readV1TokenMetadata(v1Reader, event.tokenAddress),
      readV1Graduation(v1Reader, event.tokenAddress, factory.factory),
    ]);
    return { metadata, graduated };
  },
  loadV2: async (event) => {
    const factory = factories.find((item) => item.version === 'v2')!;
    const [record, metadata, quoteAsset] = await Promise.all([
      readV2LaunchRecord(v2Reader, factory.factory, event.tokenAddress),
      readV2TokenMetadata(v2Reader, event.tokenAddress),
      resolveV2QuoteAsset(event.pairToken, v2Reader),
    ]);
    return { record, metadata, quoteAsset };
  },
});
const rawGetLogs = createViemGetLogs(client);
let transientErrors = 0;
const getLogs: typeof rawGetLogs = async (source, fromBlock, toBlock) => {
  try {
    return await rawGetLogs(source, fromBlock, toBlock);
  } catch (error) {
    transientErrors++;
    console.error(JSON.stringify({ getLogsError: error instanceof Error ? error.message : String(error), sourceId: source.id }));
    throw error;
  }
};

function scanBounded(source: LogSource, target: bigint) {
  return scanToHead(source, target, {
    initialChunk: 10_000n, minChunk: 1n, maxChunk: 500_000n, maxRetries: 6,
    getCursor: repository.getCursor, getLogs, decodeLogs: decoder, saveIndexBatch: repository.saveIndexBatch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

async function run(): Promise<void> {
  const cursors = await Promise.all(sources.map((source) => repository.getCursor(source.id)));
  const targets = cursors.map((cursor) => cursor.scannedToBlock + blocksPerPhase);
  console.log(JSON.stringify({ parallelism, blocksPerPhase: blocksPerPhase.toString(),
    from: cursors.map((c) => c.scannedToBlock.toString()), to: targets.map((t) => t.toString()) }));
  const start = Date.now();
  const reports = await Promise.all(sources.map((source, i) => scanBounded(source, targets[i])));
  const ms = Date.now() - start;
  const totalBlocks = Number(blocksPerPhase) * sources.length;
  console.log(JSON.stringify({
    result: true, parallelism, ms, blocksPerSec: Math.round(totalBlocks / (ms / 1000)),
    gaps: reports.map((r) => r.missingRanges.length), transientErrors,
  }));
}

try {
  await run();
} finally {
  await pool.end();
}
