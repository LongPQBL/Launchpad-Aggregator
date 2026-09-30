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
// self-hosted Envio deployment; this test-time default targets the throwaway fixture schema used by
// runSync.integration.test.ts.
const RAW_LAUNCH_TABLE = process.env.ENVIO_RAW_LAUNCH_TABLE ?? 'envio_fixture."RawLaunch"';
const RAW_SWAP_TABLE = process.env.ENVIO_RAW_SWAP_TABLE ?? 'envio_fixture."RawSwap"';

export async function readAllRawLaunches(envioPool: Pool): Promise<EnvioRawLaunchDbRow[]> {
  const result = await envioPool.query(`SELECT * FROM ${RAW_LAUNCH_TABLE}`);
  return result.rows as EnvioRawLaunchDbRow[];
}

export async function readAllRawSwaps(envioPool: Pool): Promise<EnvioRawSwapDbRow[]> {
  const result = await envioPool.query(`SELECT * FROM ${RAW_SWAP_TABLE}`);
  return result.rows as EnvioRawSwapDbRow[];
}
