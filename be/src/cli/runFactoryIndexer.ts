import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { createDatabase } from '../db/client.js';
import { createRepository } from '../db/repository.js';
import { runFactoryCycle } from '../indexer/factoryCycle.js';
import { createFactoryDecoder } from '../indexer/factoryRuntime.js';
import { createLifecycleDecoder, getV2LifecycleSource, lifecycleTarget, readV2FactoryPoolConfig } from '../indexer/lifecycleRuntime.js';
import { reconcileCanonicalHead } from '../indexer/reorg.js';
import { scanToHead } from '../indexer/scan.js';
import { createVenueStore } from '../indexer/venueStore.js';
import { createTradeDecoder, getGroupedTradeLogs, getTradeSourceDefinitions, tradeFrontier, withVenueAddresses } from '../indexer/tradeRuntime.js';
import { createV4GetLogs, createV4TradeDecoder, getV4PoolSources } from '../indexer/v4Runtime.js';
import { selectIndexerSourceIds } from '../indexer/sourceSelection.js';
import { readV1Graduation, readV1TokenMetadata, type V1ReadClient } from '../launchpads/pons/v1/state.js';
import { readV2LaunchRecord, readV2TokenMetadata, resolveV2QuoteAsset, type V2ReadClient } from '../launchpads/pons/v2/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { createViemGetLogs, getFactoryLogSources } from './indexer.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const rpcUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const maxBlocksPerSource = BigInt(process.env.INDEXER_MAX_BLOCKS_PER_CYCLE ?? '10000');
if (maxBlocksPerSource < 1n || maxBlocksPerSource > 1_000_000n) throw new Error('Invalid INDEXER_MAX_BLOCKS_PER_CYCLE');
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
      initialChunk: 1_000n, minChunk: 1n, maxChunk: 5_000n, maxRetries: 3,
      getCursor: repository.getCursor, getLogs, decodeLogs: decoder, saveIndexBatch: repository.saveIndexBatch,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    }),
  });
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
        initialChunk: 1_000n, minChunk: 1n, maxChunk: 5_000n, maxRetries: 3,
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
  for (const definition of tradeDefinitions.filter((item) => selectedIds.includes(item.source.id))) {
    const frontier = tradeFrontier(definition.source.id, factoryCursors);
    const contexts = (await venueStore.listOfficial(definition.venueKind, definition.source.chainId))
      .filter((context) => definition.factorySourceIds.includes(context.launch.sourceId));
    const tradeSource = withVenueAddresses(definition, contexts);
    const getTimestamp = async (blockNumber: bigint) => Number((await client.getBlock({ blockNumber })).timestamp);
    const tradeReports = await runFactoryCycle([tradeSource], frontier < safeHead ? frontier : safeHead, maxBlocksPerSource, {
      getCursor: repository.getCursor, recordScanReport: repository.recordScanReport,
      setSourceStatus: repository.setSourceStatus,
      scan: (source, target) => scanToHead(source, target, {
        initialChunk: 1_000n, minChunk: 1n, maxChunk: 5_000n, maxRetries: 3,
        getCursor: repository.getCursor,
        getLogs: (group, fromBlock, toBlock) => getGroupedTradeLogs(group, fromBlock, toBlock, 100, getLogs),
        decodeLogs: createTradeDecoder(contexts, getTimestamp), saveIndexBatch: repository.saveIndexBatch,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      }),
    });
    reports.push(...tradeReports);
  }
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
      const getTimestamp = async (blockNumber: bigint) => Number((await client.getBlock({ blockNumber })).timestamp);
      reports.push(...await runFactoryCycle([source], safeHead, maxBlocksPerSource, {
        getCursor: repository.getCursor, recordScanReport: repository.recordScanReport,
        setSourceStatus: repository.setSourceStatus,
        scan: (poolSource, target) => scanToHead(poolSource, target, {
          initialChunk: 1_000n, minChunk: 1n, maxChunk: 5_000n, maxRetries: 3,
          getCursor: repository.getCursor,
          getLogs: createV4GetLogs(client as unknown as Parameters<typeof createV4GetLogs>[0], poolManager, source.poolId),
          decodeLogs: createV4TradeDecoder(context, getTimestamp, poolManager, hook),
          saveIndexBatch: repository.saveIndexBatch,
          sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        }),
      }));
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

try {
  await runOnce();
  while (process.env.INDEXER_ONCE !== 'true') {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await runOnce();
  }
} finally {
  await pool.end();
}
