import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { createDatabase } from '../db/client.js';
import { createRepository } from '../db/repository.js';
import { createBatchedGetBlockData } from '../indexer/blockDataBatch.js';
import { scanToHead, type LogSource } from '../indexer/scan.js';
import { createVenueStore } from '../indexer/venueStore.js';
import { createTradeDecoder, getGroupedTradeLogs, getTradeSourceDefinitions, tradeFrontier, withVenueAddresses } from '../indexer/tradeRuntime.js';
import { createViemGetLogs } from './indexer.js';

// One-off experiment: trade-decoding sources already fetch timestamps/traders with internal
// concurrency (RPC_FETCH_CONCURRENCY each) — does running several of THESE in parallel still
// help, or does it hit the RPC's shared ceiling faster than log-only sources did?
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const blocksPerPhase = BigInt(process.env.BENCH_BLOCKS ?? '150000');
const parallelism = Number(process.env.BENCH_PARALLEL ?? '2');
const { db, pool } = createDatabase(databaseUrl);
const repository = createRepository(db);
const client = createRobinhoodPublicClient(rpcUrl);
const venueStore = createVenueStore(pool);
const tradeDefinitions = getTradeSourceDefinitions().slice(0, parallelism);
if (tradeDefinitions.length < parallelism) throw new Error(`Only ${getTradeSourceDefinitions().length} trade sources available`);
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
const getBlocksData = createBatchedGetBlockData(rpcUrl, 100);

async function scanBounded(source: LogSource, contexts: Awaited<ReturnType<typeof venueStore.listOfficial>>, target: bigint) {
  return scanToHead(source, target, {
    initialChunk: 10_000n, minChunk: 1n, maxChunk: 500_000n, maxRetries: 6,
    getCursor: repository.getCursor,
    getLogs: (group, fromBlock, toBlock) => getGroupedTradeLogs(group, fromBlock, toBlock, 100, getLogs),
    decodeLogs: createTradeDecoder(contexts, getBlocksData), saveIndexBatch: repository.saveIndexBatch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

async function run(): Promise<void> {
  const factoryCursors = new Map(await Promise.all(
    ['pons-v1-legacy', 'pons-v1-active', 'pons-v2'].map(async (id) => [id, (await repository.getCursor(id)).scannedToBlock] as const),
  ));
  const prepared = await Promise.all(tradeDefinitions.map(async (definition) => {
    const contexts = (await venueStore.listOfficial(definition.venueKind, definition.source.chainId))
      .filter((context) => definition.factorySourceIds.includes(context.launch.sourceId));
    const source = withVenueAddresses(definition, contexts);
    const frontier = tradeFrontier(definition.source.id, factoryCursors);
    const cursor = await repository.getCursor(definition.source.id);
    const target = cursor.scannedToBlock + blocksPerPhase;
    const boundedTarget = target < frontier ? target : frontier;
    return { source, contexts, from: cursor.scannedToBlock, target: boundedTarget };
  }));
  console.log(JSON.stringify({ parallelism, blocksPerPhase: blocksPerPhase.toString(),
    ids: prepared.map((p) => p.source.id), from: prepared.map((p) => p.from.toString()), to: prepared.map((p) => p.target.toString()) }));
  const start = Date.now();
  const reports = await Promise.all(prepared.map((p) => scanBounded(p.source, p.contexts, p.target)));
  const ms = Date.now() - start;
  const totalBlocks = prepared.reduce((sum, p) => sum + Number(p.target - p.from), 0);
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
