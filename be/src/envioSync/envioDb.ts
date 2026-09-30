import type { Pool } from 'pg';

export interface EnvioRawLaunchDbRow {
  id: string;
  chainId: number;
  tokenAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  poolAddress: string;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export interface EnvioRawSwapDbRow {
  id: string;
  chainId: number;
  poolAddress: string;
  sender: string;
  recipient: string;
  txFrom: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
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
