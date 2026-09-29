import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { createDatabase } from '../db/client.js';
import { createRepository } from '../db/repository.js';
import { runFactoryCycle } from '../indexer/factoryCycle.js';
import { createFactoryDecoder } from '../indexer/factoryRuntime.js';
import { reconcileCanonicalHead } from '../indexer/reorg.js';
import { scanToHead } from '../indexer/scan.js';
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
const factories = getPonsFactorySources();
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
const getLogs = createViemGetLogs(client);

for (const factory of factories) {
  await repository.registerSource({ id: factory.id, chainId: factory.chainId, version: factory.version,
    factoryAddress: factory.factory, startBlock: factory.startBlock });
}

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
  const reports = await runFactoryCycle(sources, safeHead, maxBlocksPerSource, {
    getCursor: repository.getCursor,
    setSourceStatus: repository.setSourceStatus,
    scan: (source, target) => scanToHead(source, target, {
      initialChunk: 1_000n, minChunk: 1n, maxChunk: 5_000n, maxRetries: 3,
      getCursor: repository.getCursor, getLogs, decodeLogs: decoder, saveIndexBatch: repository.saveIndexBatch,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    }),
  });
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
