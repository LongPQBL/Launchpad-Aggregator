import type { Hash } from 'viem';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { createDatabase } from '../db/client.js';
import { createRepository } from '../db/repository.js';
import type { IndexBatch } from '../domain/types.js';
import { createBatchedGetBlockData } from '../indexer/blockDataBatch.js';
import { eligibleVenues } from '../indexer/eligibleVenues.js';
import { runFactoryCycle } from '../indexer/factoryCycle.js';
import { createFactoryDecoder } from '../indexer/factoryRuntime.js';
import type { ScanJob } from '../indexer/jobTypes.js';
import type { SourceDefinition } from '../indexer/jobPlanner.js';
import { runJobScheduler, type SchedulerDeps } from '../indexer/jobScheduler.js';
import { runPonsJob } from '../indexer/ponsJobWorker.js';
import { createLifecycleDecoder, getV2LifecycleSource, lifecycleTarget, readV2FactoryPoolConfig } from '../indexer/lifecycleRuntime.js';
import { reconcileV2Phase } from '../indexer/phaseReconcile.js';
import { reconcileCanonicalHead } from '../indexer/reorg.js';
import { safeErrorMessage, scanChunkBounds, scanToHead } from '../indexer/scan.js';
import { createVenueStore, type VenueContext } from '../indexer/venueStore.js';
import { computeGroupSize, createTradeDecoder, getGroupedTradeLogs, getTradeSourceDefinitions, tradeFrontier, withVenueAddresses } from '../indexer/tradeRuntime.js';
import { createV4GetLogs, createV4TradeDecoder, getV4PoolSources } from '../indexer/v4Runtime.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import { selectIndexerSourceIds } from '../indexer/sourceSelection.js';
import { readV1Graduation, readV1TokenMetadata, type V1ReadClient } from '../launchpads/pons/v1/state.js';
import { readV2LaunchRecord, readV2Phase, readV2TokenMetadata, resolveV2QuoteAsset, type V2ReadClient } from '../launchpads/pons/v2/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { createViemGetLogs, getFactoryLogSources } from './indexer.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
// Trade sources default to the shared RPC but can be pointed at their own dedicated endpoint —
// e.g. RH_RPC_URL_PONS_V1_LEGACY_TRADES for source id "pons-v1-legacy-trades" — so each can run
// against its own provider account/quota instead of contending for the shared one (see README.md,
// 2026-09-30: the free public RPC proved permanently unreliable for these specific sources).
function tradeSourceRpcUrl(sourceId: string): string {
  const envKey = `RH_RPC_URL_${sourceId.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] ?? rpcUrl;
}
const maxBlocksPerSource = BigInt(process.env.INDEXER_MAX_BLOCKS_PER_CYCLE ?? '10000');
if (maxBlocksPerSource < 1n || maxBlocksPerSource > 1_000_000n) throw new Error('Invalid INDEXER_MAX_BLOCKS_PER_CYCLE');
const sharedLogChunks = scanChunkBounds(BigInt(process.env.INDEXER_SHARED_RPC_LOG_RANGE ?? '500000'));
const { db, pool } = createDatabase(databaseUrl);
const repository = createRepository(db);
const client = createRobinhoodPublicClient(rpcUrl);
const sources = getFactoryLogSources();
const lifecycleSource = getV2LifecycleSource();
const v4SelectionId = 'pons-v2-v4';
const tradeDefinitions = getTradeSourceDefinitions();
const selectedIds = selectIndexerSourceIds([...sources.map((source) => source.id), lifecycleSource.id, v4SelectionId,
  ...tradeDefinitions.map((definition) => definition.source.id)],
  process.env.INDEXER_SOURCE_IDS);
const venueStore = createVenueStore(pool);
const factories = getPonsFactorySources();
const v1Reader = client as unknown as V1ReadClient;
const v2Reader = client as unknown as V2ReadClient;
let poolConfigPromise: ReturnType<typeof readV2FactoryPoolConfig> | undefined;
function getPoolConfig() {
  poolConfigPromise ??= readV2FactoryPoolConfig(client as unknown as Parameters<typeof readV2FactoryPoolConfig>[0]);
  return poolConfigPromise;
}
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
const getLogs = createViemGetLogs(client);
const getBlocksData = createBatchedGetBlockData(rpcUrl, 100);

for (const factory of factories) {
  await repository.registerSource({ id: factory.id, chainId: factory.chainId, version: factory.version,
    factoryAddress: factory.factory, startBlock: factory.startBlock });
}
for (const definition of tradeDefinitions) {
  await repository.registerSource({ id: definition.source.id, chainId: definition.source.chainId,
    version: definition.version, factoryAddress: definition.factoryAddress, startBlock: definition.source.startBlock });
}
await repository.registerSource({ id: lifecycleSource.id, chainId: lifecycleSource.chainId, version: 'v2-lifecycle',
  factoryAddress: lifecycleSource.addresses[0], startBlock: lifecycleSource.startBlock });

async function runOnce(): Promise<void> {
  const head = await client.getBlockNumber();
  const safeHead = head > 12n ? head - 12n : 0n;
  await reconcileCanonicalHead(4663, safeHead, {
    reorgWindow: 64n,
    getStoredBlocks: repository.getObservedBlocks,
    getCanonicalBlockHash: async (_chainId, blockNumber) => (await client.getBlock({ blockNumber })).hash,
    retractBlocks: repository.retractBlocks,
    scanToSafeHead: async () => { /* The bounded factory cycle below resumes from the retracted checkpoint. */ },
  });
  await repository.recordObservedBlock(4663, safeHead, (await client.getBlock({ blockNumber: safeHead })).hash);
  const reports = await runFactoryCycle(sources.filter((source) => selectedIds.includes(source.id)), safeHead, maxBlocksPerSource, {
    getCursor: repository.getCursor,
    recordScanReport: repository.recordScanReport,
    setSourceStatus: repository.setSourceStatus,
    scan: (source, target) => scanToHead(source, target, {
      ...sharedLogChunks, minChunk: 1n, maxRetries: 6,
      getCursor: repository.getCursor, getLogs, decodeLogs: decoder, saveIndexBatch: repository.saveIndexBatch,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    }),
  }, { parallel: true });
  const factoryCursors = new Map(await Promise.all(sources.map(async (source) => [source.id, (await repository.getCursor(source.id)).scannedToBlock] as const)));
  if (selectedIds.includes(lifecycleSource.id)) {
    const curveContexts = (await venueStore.listOfficial('curve', lifecycleSource.chainId))
      .filter((context) => context.launch.sourceId === 'pons-v2');
    const byToken = new Map(curveContexts.map((context) => [context.launch.tokenAddress.toLowerCase(), context]));
    const poolConfig = await getPoolConfig();
    const target = lifecycleTarget(factoryCursors.get('pons-v2')!, safeHead);
    reports.push(...await runFactoryCycle([lifecycleSource], target, maxBlocksPerSource, {
      getCursor: repository.getCursor, recordScanReport: repository.recordScanReport,
      setSourceStatus: repository.setSourceStatus,
      scan: (source, head) => scanToHead(source, head, {
        ...sharedLogChunks, minChunk: 1n, maxRetries: 6,
        getCursor: repository.getCursor, getLogs,
        decodeLogs: createLifecycleDecoder({
          loadLaunch: async (token) => {
            const context = byToken.get(token.toLowerCase());
            if (!context) return null;
            if (context.launch.v4PoolFee !== null && context.launch.v4PoolFee !== undefined
              && context.launch.v4TickSpacing !== null && context.launch.v4TickSpacing !== undefined) return context;
            const factory = factories.find((item) => item.version === 'v2')!;
            const record = await readV2LaunchRecord(v2Reader, factory.factory, token);
            if (!record.exists || record.token.toLowerCase() !== token.toLowerCase()
              || record.curve.toLowerCase() !== context.venue.ref.toLowerCase()
              || record.pairToken.toLowerCase() !== context.launch.quoteAsset.address.toLowerCase()) {
              throw new Error(`Pons V2 historical pool terms do not match launch ${token}`);
            }
            await repository.setV2PoolTerms(context.launch.chainId, token, record.poolFee, record.tickSpacing);
            context.launch.v4PoolFee = record.poolFee;
            context.launch.v4TickSpacing = record.tickSpacing;
            return context;
          },
          getReceiptLogs: async (txHash) => (await client.getTransactionReceipt({ hash: txHash })).logs.map((log) => ({
            address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
            blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex,
          })),
          ...poolConfig,
        }),
        saveIndexBatch: repository.saveIndexBatch,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      }),
    }));
  }
  const tradeResults = await Promise.all(tradeDefinitions.filter((item) => selectedIds.includes(item.source.id)).map(async (definition) => {
    const frontier = tradeFrontier(definition.source.id, factoryCursors);
    const contexts = (await venueStore.listOfficial(definition.venueKind, definition.source.chainId))
      .filter((context) => definition.factorySourceIds.includes(context.launch.sourceId));
    const tradeSource = definition.source;
    // Own client per trade source (see tradeSourceRpcUrl above) — Validation Cloud's real
    // eth_getLogs range cap is 2,000 blocks (measured 2026-09-30: "Exceeded max range limit for
    // eth_getLogs: 2000"), so the chunk size is fixed to that rather than relying on scan.ts's
    // adaptive shrink, whose error-message matching doesn't recognize this provider's wording.
    const tradeRpcUrl = tradeSourceRpcUrl(definition.source.id);
    const tradeClient = createRobinhoodPublicClient(tradeRpcUrl);
    const tradeGetLogs = createViemGetLogs(tradeClient);
    const tradeGetBlocksData = createBatchedGetBlockData(tradeRpcUrl, 100);
    return runFactoryCycle([tradeSource], frontier < safeHead ? frontier : safeHead, maxBlocksPerSource, {
      getCursor: repository.getCursor, recordScanReport: repository.recordScanReport,
      setSourceStatus: repository.setSourceStatus,
      scan: (source, target) => scanToHead(source, target, {
        initialChunk: 2_000n, minChunk: 1n, maxChunk: 2_000n, maxRetries: 6,
        getCursor: repository.getCursor,
        getLogs: (_group, fromBlock, toBlock) => {
          const windowSource = withVenueAddresses(definition, contexts, { fromBlock, toBlock });
          return getGroupedTradeLogs(windowSource, fromBlock, toBlock, computeGroupSize(windowSource.addresses.length), tradeGetLogs);
        },
        decodeLogs: createTradeDecoder(contexts, tradeGetBlocksData), saveIndexBatch: repository.saveIndexBatch,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      }),
    });
  }));
  reports.push(...tradeResults.flat());
  if (selectedIds.includes(v4SelectionId)) {
    const { poolManager, hook } = await getPoolConfig();
    const contexts = (await venueStore.listOfficial('v4_pool', lifecycleSource.chainId))
      .filter((context) => context.launch.sourceId === 'pons-v2');
    const poolSources = getV4PoolSources(contexts, poolManager);
    const bySourceId = new Map(poolSources.map((source, index) => [source.id, contexts[index]]));
    for (const source of poolSources) {
      await repository.registerSource({ id: source.id, chainId: source.chainId, version: 'v2-v4',
        factoryAddress: poolManager, startBlock: source.startBlock });
      const context = bySourceId.get(source.id)!;
      reports.push(...await runFactoryCycle([source], safeHead, maxBlocksPerSource, {
        getCursor: repository.getCursor, recordScanReport: repository.recordScanReport,
        setSourceStatus: repository.setSourceStatus,
        scan: (poolSource, target) => scanToHead(poolSource, target, {
          ...sharedLogChunks, minChunk: 1n, maxRetries: 6,
          getCursor: repository.getCursor,
          getLogs: createV4GetLogs(client as unknown as Parameters<typeof createV4GetLogs>[0], poolManager, source.poolId),
          decodeLogs: createV4TradeDecoder(context, getBlocksData, poolManager, hook),
          saveIndexBatch: repository.saveIndexBatch,
          sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        }),
      }));
    }
  }
  if (selectedIds.includes(lifecycleSource.id)) {
    const [factoryCursor, lifecycleCursor] = await Promise.all([
      repository.getCursor('pons-v2'), repository.getCursor(lifecycleSource.id),
    ]);
    if (factoryCursor.status === 'caught_up' && lifecycleCursor.status === 'caught_up'
      && factoryCursor.confirmedToBlock >= safeHead && lifecycleCursor.confirmedToBlock >= safeHead) {
      const candidates = await repository.listV2PhaseAuditCandidates(4663, 1);
      for (const candidate of candidates) {
        const result = await reconcileV2Phase(candidate.lifecycleStatus, safeHead,
          (blockNumber) => readV2Phase(v2Reader, candidate.factoryAddress, candidate.tokenAddress, blockNumber));
        await repository.recordV2PhaseObservation(4663, candidate.tokenAddress, candidate.lifecycleStatus, result);
        console.log(JSON.stringify({ phaseAudit: candidate.tokenAddress, blockNumber: safeHead.toString(),
          status: result.status, reason: result.reason }));
      }
    }
  }
  for (const report of reports) {
    const cursor = await repository.getCursor(report.sourceId);
    console.log(JSON.stringify({ sourceId: report.sourceId, scannedToBlock: cursor.scannedToBlock.toString(),
      safeHead: safeHead.toString(), status: cursor.status, missingRanges: report.missingRanges.map((range) => ({
        fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString(), reason: range.reason,
      })) }));
  }
}

// --- Jobs-mode runner (INDEXER_SCHEDULER=jobs) -----------------------------------------------
// Bounded parallel scheduler over durable, leased block-window jobs (see
// docs/superpowers/specs/2026-09-30-parallel-indexer-design.md). Kept behind an explicit flag so
// the sequential runOnce() above remains selectable for rollback per the plan's Global Constraints.
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface VenueSnapshot { curve: VenueContext[]; v3Pool: VenueContext[]; v4Pool: VenueContext[] }
let venueSnapshot: VenueSnapshot = { curve: [], v3Pool: [], v4Pool: [] };
async function refreshVenueSnapshot(): Promise<void> {
  const [curve, v3Pool, v4Pool] = await Promise.all([
    venueStore.listOfficial('curve', 4663), venueStore.listOfficial('v3_pool', 4663), venueStore.listOfficial('v4_pool', 4663),
  ]);
  venueSnapshot = { curve, v3Pool, v4Pool };
}

function jobTradeDefinition(sourceId: string) {
  return tradeDefinitions.find((definition) => definition.source.id === sourceId);
}
function jobTradeContexts(definition: NonNullable<ReturnType<typeof jobTradeDefinition>>): VenueContext[] {
  const pool = definition.venueKind === 'curve' ? venueSnapshot.curve : venueSnapshot.v3Pool;
  return pool.filter((context) => definition.factorySourceIds.includes(context.launch.sourceId));
}

// listSources/getFrontiers run concurrently (jobScheduler.ts calls both via Promise.all), so each
// refreshes and registers V4 pools independently rather than sharing one pass's snapshot — a
// deliberately redundant venue query per pass, not per planned window.
async function listJobSources(): Promise<SourceDefinition[]> {
  await refreshVenueSnapshot();
  const { poolManager } = await getPoolConfig();
  const v4Sources = getV4PoolSources(venueSnapshot.v4Pool.filter((context) => context.launch.sourceId === 'pons-v2'), poolManager);
  for (const source of v4Sources) {
    await repository.registerSource({ id: source.id, chainId: source.chainId, version: 'v2-v4',
      factoryAddress: poolManager, startBlock: source.startBlock });
  }
  const base: SourceDefinition[] = [
    ...sources.map((source) => ({ id: source.id, startBlock: source.startBlock })),
    { id: lifecycleSource.id, startBlock: lifecycleSource.startBlock },
    ...tradeDefinitions.map((definition) => ({ id: definition.source.id, startBlock: definition.source.startBlock })),
    ...v4Sources.map((source) => ({ id: source.id, startBlock: source.startBlock, verifiedInitialize: true })),
  ];
  return base.filter((source) => selectedIds.includes(source.id)
    || (source.id.startsWith('pons-v2-v4:') && selectedIds.includes(v4SelectionId)));
}

async function getJobFrontiers(): Promise<ReadonlyMap<string, bigint>> {
  const list = await listJobSources();
  const entries = await Promise.all(list.map(async (source) => [source.id, await repository.getCertifiedFrontier(source.id)] as const));
  return new Map(entries);
}

async function estimateJobPoolCount(sourceId: string, fromBlock: bigint, toBlock: bigint): Promise<number> {
  const definition = jobTradeDefinition(sourceId);
  if (!definition) return 0;
  return eligibleVenues(jobTradeContexts(definition), fromBlock, toBlock).length;
}

async function executeJob(job: ScanJob): Promise<IndexBatch> {
  const factorySource = sources.find((source) => source.id === job.sourceId);
  if (factorySource) return runPonsJob(job, { source: factorySource, getLogs, decodeLogs: decoder, sleep });
  if (job.sourceId === lifecycleSource.id) {
    const poolConfig = await getPoolConfig();
    const byToken = new Map(venueSnapshot.curve.filter((context) => context.launch.sourceId === 'pons-v2')
      .map((context) => [context.launch.tokenAddress.toLowerCase(), context]));
    return runPonsJob(job, {
      source: lifecycleSource, getLogs,
      decodeLogs: createLifecycleDecoder({
        loadLaunch: async (token) => {
          const context = byToken.get(token.toLowerCase());
          if (!context) return null;
          if (context.launch.v4PoolFee !== null && context.launch.v4PoolFee !== undefined
            && context.launch.v4TickSpacing !== null && context.launch.v4TickSpacing !== undefined) return context;
          const factory = factories.find((item) => item.version === 'v2')!;
          const record = await readV2LaunchRecord(v2Reader, factory.factory, token);
          if (!record.exists || record.token.toLowerCase() !== token.toLowerCase()
            || record.curve.toLowerCase() !== context.venue.ref.toLowerCase()
            || record.pairToken.toLowerCase() !== context.launch.quoteAsset.address.toLowerCase()) {
            throw new Error(`Pons V2 historical pool terms do not match launch ${token}`);
          }
          await repository.setV2PoolTerms(context.launch.chainId, token, record.poolFee, record.tickSpacing);
          context.launch.v4PoolFee = record.poolFee;
          context.launch.v4TickSpacing = record.tickSpacing;
          return context;
        },
        getReceiptLogs: async (txHash) => (await client.getTransactionReceipt({ hash: txHash })).logs.map((log) => ({
          address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
          blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex,
        })),
        ...poolConfig,
      }),
      sleep,
    });
  }
  const definition = jobTradeDefinition(job.sourceId);
  if (definition) {
    const contexts = jobTradeContexts(definition);
    const tradeRpcUrl = tradeSourceRpcUrl(job.sourceId);
    const tradeClient = createRobinhoodPublicClient(tradeRpcUrl);
    const tradeGetLogs = createViemGetLogs(tradeClient);
    const tradeGetBlocksData = createBatchedGetBlockData(tradeRpcUrl, 100);
    const windowSource = withVenueAddresses(definition, contexts, { fromBlock: job.fromBlock, toBlock: job.toBlock });
    return runPonsJob(job, {
      source: windowSource,
      getLogs: (_source, fromBlock, toBlock) =>
        getGroupedTradeLogs(windowSource, fromBlock, toBlock, computeGroupSize(windowSource.addresses.length), tradeGetLogs),
      decodeLogs: createTradeDecoder(contexts, tradeGetBlocksData),
      sleep,
    });
  }
  if (job.sourceId.startsWith('pons-v2-v4:')) {
    const { poolManager, hook } = await getPoolConfig();
    const context = venueSnapshot.v4Pool.find((item) => `pons-v2-v4:${item.venue.ref.toLowerCase()}` === job.sourceId);
    if (!context) throw new Error(`Unknown V4 pool source: ${job.sourceId}`);
    const poolId = context.venue.ref.toLowerCase() as Hash;
    return runPonsJob(job, {
      source: { id: job.sourceId, chainId: 4663, startBlock: context.venue.effectiveFromBlock, addresses: [poolManager], events: [v4SwapEvent] },
      getLogs: createV4GetLogs(client as unknown as Parameters<typeof createV4GetLogs>[0], poolManager, poolId),
      decodeLogs: createV4TradeDecoder(context, getBlocksData, poolManager, hook),
      sleep,
    });
  }
  throw new Error(`Unknown job source: ${job.sourceId}`);
}

async function runJobsMode(): Promise<void> {
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Each trade source has its own dedicated RPC endpoint (tradeSourceRpcUrl) whose internal
  // address-group concurrency (TRADE_LOG_GROUP_CONCURRENCY) is already 20 — 2 concurrent
  // job-windows per trade source lets the scheduler work ahead on the next window while a slow
  // one is still running, without contending with the shared factory/lifecycle/V4 endpoint.
  const endpointLimits: Record<string, number> = { shared: 3 };
  for (const definition of tradeDefinitions) endpointLimits[definition.source.id] = 2;
  const deps: SchedulerDeps = {
    once: process.env.INDEXER_ONCE === 'true',
    endpointLimits,
    endpointFor: (sourceId) => jobTradeDefinition(sourceId) ? sourceId : 'shared',
    // Reorg check runs once per scheduler pass, piggybacking on the existing safe-head lookup (mirrors
    // runOnce()'s per-cycle check above). invalidateJobsFrom replaces retractBlocks here specifically so a
    // detected fork also deletes any now-invalid scan_jobs rows, not just the canonical-dependent data —
    // see invalidateJobsFrom's own comment in repository.ts for why deletion (not a reset-in-place) is
    // required for the job-queue scheduler. The scheduler's own next pass replans from the rolled-back
    // certified frontier, so scanToSafeHead has nothing to do here (unlike the sequential runner's).
    getSafeHead: async () => {
      const head = await client.getBlockNumber();
      const safeHead = head > 12n ? head - 12n : 0n;
      await reconcileCanonicalHead(4663, safeHead, {
        reorgWindow: 64n,
        getStoredBlocks: repository.getObservedBlocks,
        getCanonicalBlockHash: async (_chainId, blockNumber) => (await client.getBlock({ blockNumber })).hash,
        retractBlocks: (chainId, fromBlock) => repository.invalidateJobsFrom(chainId, fromBlock),
        scanToSafeHead: async () => { /* the next scheduler pass replans from the rolled-back frontier */ },
      });
      await repository.recordObservedBlock(4663, safeHead, (await client.getBlock({ blockNumber: safeHead })).hash);
      return safeHead;
    },
    listSources: listJobSources,
    getFrontiers: getJobFrontiers,
    estimatePoolCount: estimateJobPoolCount,
    // Bound: createRepository returns a plain object whose methods call this.persistBatchInTransaction
    // internally, so passing them unbound as bare references loses `this` when jobScheduler invokes them.
    enqueueJob: repository.enqueueScanJob.bind(repository),
    claimJob: repository.claimScanJob.bind(repository),
    executeJob,
    commitJob: repository.commitScanJob.bind(repository),
    failJob: repository.failScanJob.bind(repository),
    now: () => new Date(),
    wait: (milliseconds, signal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    leaseMs: 120_000,
    pollMs: 5_000,
    onReport: (report) => console.log(JSON.stringify(report)),
    // Reserve 1 of the shared endpoint's 3 workers for near-head factory scans so new launches
    // surface at safe head without waiting behind historical backfill (docs/superpowers/specs/
    // 2026-09-30-parallel-indexer-design.md §4.1); the other 2 keep backfilling certified history.
    enqueueProvisionalWindow: repository.replaceProvisionalWindow.bind(repository),
    provisionalWorkers: 1,
  };
  await runJobScheduler(deps, abortController.signal);
}

// A single cycle can still throw outside scanToHead's own retry/backoff (e.g. the safe-head
// getBlockNumber/getBlock calls above aren't wrapped). For a long unattended run, one such
// hiccup must not kill the whole process — log it and keep cycling; the next cycle resumes
// from the last saved checkpoint, so nothing is lost besides this cycle's attempt.
try {
  if (process.env.INDEXER_SCHEDULER === 'jobs') {
    await runJobsMode();
  } else for (;;) {
    try {
      await runOnce();
    } catch (error) {
      console.error(JSON.stringify({ cycleError: safeErrorMessage(error) }));
    }
    if (process.env.INDEXER_ONCE === 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
} finally {
  await pool.end();
}
