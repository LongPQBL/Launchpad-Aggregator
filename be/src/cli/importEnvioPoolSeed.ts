import { createDatabase } from '../db/client.js';
import { ENVIO_POOL_SEED_RANGE, importEnvioPoolSeed } from '../pools/importEnvioSeed.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function blockArgument(name: string, fallback: bigint): bigint {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a block number`);
  return BigInt(raw);
}

if (process.argv.includes('--help')) {
  console.log('Usage: pnpm pools:import-envio-seed -- --graphql-url <seed-indexer-graphql-url> [--start-block 8600612] [--end-block 111584773] [--watch] [--poll-ms 2000] [--token <cloud-token>]');
  process.exit(0);
}

const endpoint = argument('--graphql-url');
if (!endpoint) throw new Error('--graphql-url is required');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const startBlock = blockArgument('--start-block', ENVIO_POOL_SEED_RANGE.startBlock);
const endBlock = blockArgument('--end-block', ENVIO_POOL_SEED_RANGE.endBlock);
const pollMs = Number(argument('--poll-ms') ?? '2000');
if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 300_000) throw new Error('--poll-ms must be 1000–300000');

const { db, pool } = createDatabase(databaseUrl);
try {
  let consecutiveErrors = 0;
  let lastReportedNextBlock = startBlock;
  let lastReportedAt = Date.now();
  while (true) {
    try {
      const result = await importEnvioPoolSeed(db, pool, endpoint, {
        bearerToken: argument('--token'),
        startBlock,
        endBlock,
        onProgress: (progress) => {
          const now = Date.now();
          const elapsedSeconds = Math.max((now - lastReportedAt) / 1000, 0.001);
          const blocksPerSecond = Number(progress.nextBlock - lastReportedNextBlock) / elapsedSeconds;
          console.log('Envio seed sync:', {
            ...progress,
            nextBlock: progress.nextBlock.toString(),
            progressBlock: progress.progressBlock.toString(),
            blocksPerSecond: Math.round(blocksPerSecond),
            blocksBehindCloud: (progress.progressBlock - progress.nextBlock).toString(),
          });
          lastReportedNextBlock = progress.nextBlock;
          lastReportedAt = now;
        },
      });
      consecutiveErrors = 0;
      if (result.complete) {
        console.log('Envio pool seed import complete:', {
          ...result,
          nextBlock: result.nextBlock.toString(),
          progressBlock: result.progressBlock.toString(),
        });
        break;
      }
      if (!process.argv.includes('--watch')) {
        console.log('Cloud seed is still indexing; run with --watch to keep importing as it progresses.');
        break;
      }
    } catch (error) {
      if (!process.argv.includes('--watch')) throw error;
      consecutiveErrors += 1;
      console.error(`Seed sync failed (retry ${consecutiveErrors}):`, error);
      const backoff = Math.min(pollMs * (2 ** Math.min(consecutiveErrors - 1, 5)), 60_000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} finally {
  await pool.end();
}
