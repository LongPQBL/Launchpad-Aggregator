import type { Pool } from 'pg';
import { keccak256, toHex } from 'viem';
import type { Database } from '../db/client.js';
import { poolPendingSwaps, poolSourceAudits, poolSyncCursors } from '../db/schema.js';
import { and, eq, lte } from 'drizzle-orm';
import { DEFAULT_ADDITIONAL_POOL_TABLES } from './syncV3V2Pools.js';
import { SOURCE_DEPLOYMENT_BLOCK, V2_FACTORY, V3_FACTORY, type AdditionalPoolProtocol } from './sourceRegistry.js';

export interface SourceLog { blockNumber: string; blockHash: string; transactionHash: string; logIndex: string }
export interface SourceLogReader { getLogs(input: { address: string; topic: string; fromBlock: bigint; toBlock: bigint }): Promise<SourceLog[]> }
export interface PoolParityInput { protocol: AdditionalPoolProtocol; chainId: number; fromBlock: bigint; toBlock: bigint;
  samplePoolAddress: string; tables?: Partial<typeof DEFAULT_ADDITIONAL_POOL_TABLES> }
export interface PoolParityReport { protocol: AdditionalPoolProtocol; fromBlock: string; toBlock: string;
  factoryLogCount: number; poolSwapLogCount: number; complete: boolean; mismatches: readonly string[] }
const signatures = {
  uniswap_v3: { factory: 'PoolCreated(address,address,uint24,int24,address)',
    swap: 'Swap(address,address,int256,int256,uint160,uint128,int24)' },
  uniswap_v2: { factory: 'PairCreated(address,address,address,uint256)',
    swap: 'Swap(address,uint256,uint256,uint256,uint256,address)' },
} as const;
const SAFE_TABLE = /^"?[A-Za-z_][A-Za-z0-9_]*"?\."?[A-Za-z_][A-Za-z0-9_]*"?$/;
function key(row: { blockHash: string; transactionHash: string; logIndex: string | number }): string {
  return `${row.blockHash.toLowerCase()}:${row.transactionHash.toLowerCase()}:${Number(row.logIndex)}`;
}
function differences(rpc: SourceLog[], raw: { blockHash: string; txHash: string; logIndex: number }[], label: string): string[] {
  const a = new Set(rpc.map(key));
  const b = new Set(raw.map((row) => key({ ...row, transactionHash: row.txHash })));
  return [...a].filter((value) => !b.has(value)).map((value) => `${label} missing from Envio: ${value}`)
    .concat([...b].filter((value) => !a.has(value)).map((value) => `${label} absent on RPC: ${value}`));
}

/** Compare bounded canonical factory and one verified pool's Swap logs against Envio raw rows. */
export async function comparePoolSourceWindow(envioPool: Pool, rpc: SourceLogReader,
  input: PoolParityInput): Promise<PoolParityReport> {
  if (input.chainId !== 4663 || input.fromBlock < SOURCE_DEPLOYMENT_BLOCK[input.protocol]
    || input.toBlock < input.fromBlock || input.toBlock - input.fromBlock > 10_000n) throw new Error('Invalid parity window');
  const tables = { ...DEFAULT_ADDITIONAL_POOL_TABLES, ...input.tables };
  const prefix = input.protocol === 'uniswap_v3' ? 'v3' : 'v2';
  const factoryTable = tables[`${prefix}_created`];
  const swapTable = tables[`${prefix}_swap`];
  if (!SAFE_TABLE.test(factoryTable) || !SAFE_TABLE.test(swapTable)) throw new Error('Unsafe parity table');
  const factoryAddress = input.protocol === 'uniswap_v3' ? V3_FACTORY : V2_FACTORY;
  const [factoryLogs, poolLogs, rawFactory, rawSwaps] = await Promise.all([
    rpc.getLogs({ address: factoryAddress, topic: keccak256(toHex(signatures[input.protocol].factory)),
      fromBlock: input.fromBlock, toBlock: input.toBlock }),
    rpc.getLogs({ address: input.samplePoolAddress, topic: keccak256(toHex(signatures[input.protocol].swap)),
      fromBlock: input.fromBlock, toBlock: input.toBlock }),
    envioPool.query(`SELECT "blockHash","txHash","logIndex" FROM ${factoryTable}
      WHERE "chainId"=$1 AND "blockNumber" BETWEEN $2 AND $3`,
    [input.chainId, input.fromBlock.toString(), input.toBlock.toString()]),
    envioPool.query(`SELECT "blockHash","txHash","logIndex" FROM ${swapTable}
      WHERE "chainId"=$1 AND "blockNumber" BETWEEN $2 AND $3 AND "${prefix === 'v3' ? 'poolAddress' : 'pairAddress'}"=$4`,
    [input.chainId, input.fromBlock.toString(), input.toBlock.toString(), input.samplePoolAddress.toLowerCase()]),
  ]);
  const mismatches = differences(factoryLogs, rawFactory.rows, 'factory')
    .concat(differences(poolLogs, rawSwaps.rows, 'pool swap'));
  return { protocol: input.protocol, fromBlock: input.fromBlock.toString(), toBlock: input.toBlock.toString(),
    factoryLogCount: factoryLogs.length, poolSwapLogCount: poolLogs.length,
    complete: mismatches.length === 0 && factoryLogs.length > 0 && poolLogs.length > 0, mismatches };
}

/** Promote a source only when bounded parity matches and both history streams reach the safe head. */
export async function recordPoolSourceParity(appDb: Database, report: PoolParityReport, chainId: number,
  safeHead: bigint): Promise<'complete' | 'pending' | 'mismatch'> {
  const source = report.protocol;
  const prefix = source === 'uniswap_v3' ? 'v3' : 'v2';
  const cursors = await appDb.select().from(poolSyncCursors).where(and(eq(poolSyncCursors.chainId, chainId),
    eq(poolSyncCursors.lane, 'history')));
  const caughtUp = (['created', 'swap'] as const).every((suffix) => cursors.some((row) =>
    row.stream === `${prefix}_${suffix}` && (row.processedWatermark ?? -1n) >= safeHead));
  const pending = await appDb.select({ id: poolPendingSwaps.rawId }).from(poolPendingSwaps).where(and(
    eq(poolPendingSwaps.chainId, chainId), eq(poolPendingSwaps.protocol, source),
    lte(poolPendingSwaps.blockNumber, safeHead))).limit(1);
  const sampledToBlock = BigInt(report.toBlock);
  const status = report.mismatches.length > 0 ? 'mismatch'
    : report.complete && sampledToBlock >= safeHead && caughtUp && pending.length === 0
    ? 'complete' : 'pending';
  await appDb.insert(poolSourceAudits).values({ chainId, protocol: source,
    factoryAddress: source === 'uniswap_v3' ? V3_FACTORY : V2_FACTORY,
    deploymentBlock: SOURCE_DEPLOYMENT_BLOCK[source], auditedToBlock: sampledToBlock, status, checkedAt: new Date() })
    .onConflictDoUpdate({ target: [poolSourceAudits.chainId, poolSourceAudits.protocol],
      set: { auditedToBlock: sampledToBlock, status, checkedAt: new Date() } });
  return status;
}

export function rpcSourceLogReader(url: string): SourceLogReader {
  return { async getLogs({ address, topic, fromBlock, toBlock }) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address, topics: [topic],
        fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }] }),
      signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Pool source RPC failed: ${response.status}`);
    const json = await response.json() as { result?: SourceLog[]; error?: { message: string } };
    if (json.error || !json.result) throw new Error(`Pool source RPC failed: ${json.error?.message ?? 'missing result'}`);
    return json.result;
  } };
}
