import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { envioChainProgress } from '../db/schema.js';

export async function readEnvioProgress(envioPool: Pool, tableName = 'envio.chain_metadata'):
Promise<{ processedBlock: bigint; headBlock: bigint }> {
  const result = await envioPool.query(`SELECT latest_processed_block, block_height FROM ${tableName} WHERE chain_id = $1`, [4663]);
  const row = result.rows[0] as { latest_processed_block: number | string | null; block_height: number | string | null } | undefined;
  if (!row || row.latest_processed_block === null || row.block_height === null) {
    throw new Error('Envio chain progress is unavailable for chain 4663');
  }
  return { processedBlock: BigInt(row.latest_processed_block), headBlock: BigInt(row.block_height) };
}

// Mirrors Envio's own chain head into the app's own database (envio_chain_progress), so
// be/src/api/store.ts's safeHead()/coverage() can see it without the API process needing a second
// database connection to Envio's own Postgres. Written once per real-table sync cycle — see
// be/src/envioSync/syncAll.ts's runAllSyncsOnce.
export async function recordEnvioChainProgress(appDb: Database, chainId: number, headBlock: bigint): Promise<void> {
  await appDb.insert(envioChainProgress).values({ chainId, headBlock })
    .onConflictDoUpdate({ target: envioChainProgress.chainId, set: { headBlock, updatedAt: new Date() } });
}

export interface EnvioRawLaunchDbRow {
  id: string;
  chainId: number;
  tokenAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  poolAddress: string;
  factoryAddress: string;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export interface EnvioRawSwapDbRow {
  id: string;
  chainId: number;
  poolAddress: string;
  txFrom: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

// Table/schema name is empirically confirmed in Task 1 Step 7 / Task 2 Step 7 against a real
// self-hosted Envio deployment. Caller-supplied (not env-read here) so production code defaults to
// the real schema and only a test explicitly opts into a throwaway fixture schema — see
// runSync.ts's DEFAULT_ENVIO_TABLES and runSync.integration.test.ts's explicit override.
// Ordered by (blockNumber, logIndex) so a mid-run failure always fails on the same row deterministically
// (be/src/envioSync/runSync.ts's error messages name the failing row) instead of a random insertion order.
export async function readAllRawLaunches(envioPool: Pool, tableName: string): Promise<EnvioRawLaunchDbRow[]> {
  const result = await envioPool.query(`SELECT * FROM ${tableName} ORDER BY "blockNumber", "logIndex"`);
  return result.rows as EnvioRawLaunchDbRow[];
}

export async function readAllRawSwaps(envioPool: Pool, tableName: string): Promise<EnvioRawSwapDbRow[]> {
  const result = await envioPool.query(`SELECT * FROM ${tableName} ORDER BY "blockNumber", "logIndex"`);
  return result.rows as EnvioRawSwapDbRow[];
}
