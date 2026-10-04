import type { Pool } from 'pg';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';

export interface ParityEvent {
  chainId: number; factoryAddress: string; txHash: string; logIndex: number;
  blockNumber: bigint; blockHash: string | null;
}
export interface ParityInput {
  source: FactorySource; fromBlock: bigint; toBlock: bigint; fence: bigint;
  chainEvents: readonly ParityEvent[]; envioRows: readonly ParityEvent[]; appRows: readonly ParityEvent[];
  envioWatermark: bigint; appWatermark: bigint; provider: string;
}
export interface ParityReport {
  sourceId: string; registryVersion: number; fromBlock: bigint; toBlock: bigint; fence: bigint;
  envioWatermark: bigint; appWatermark: bigint; provider: string;
  status: 'complete' | 'mismatch' | 'pending';
  counts: { chain: number; envio: number; app: number };
  firstBlock: bigint | null; lastBlock: bigint | null;
  missingEnvio: ParityEvent[]; extraEnvio: ParityEvent[];
  missingApp: ParityEvent[]; extraApp: ParityEvent[];
  hashMismatches: { layer: 'envio' | 'app'; event: ParityEvent }[];
  duplicateKeys: { layer: 'chain' | 'envio' | 'app'; event: ParityEvent }[];
}

function key(row: ParityEvent): string {
  return `${row.chainId}:${row.factoryAddress.toLowerCase()}:${row.txHash.toLowerCase()}:${row.logIndex}`;
}
function index(rows: readonly ParityEvent[], layer: 'chain' | 'envio' | 'app', duplicates: ParityReport['duplicateKeys']): Map<string, ParityEvent> {
  const byKey = new Map<string, ParityEvent>();
  for (const row of rows) {
    const id = key(row);
    if (byKey.has(id)) duplicates.push({ layer, event: row });
    else byKey.set(id, row);
  }
  return byKey;
}

export function compareLaunchRange(input: ParityInput): ParityReport {
  const { source, fromBlock, toBlock, fence } = input;
  if (fromBlock < source.startBlock || toBlock < fromBlock) throw new Error('Invalid parity range');
  const duplicateKeys: ParityReport['duplicateKeys'] = [];
  const chain = index(input.chainEvents, 'chain', duplicateKeys);
  const envio = index(input.envioRows, 'envio', duplicateKeys);
  const app = index(input.appRows, 'app', duplicateKeys);
  const missingEnvio = [...chain].filter(([id]) => !envio.has(id)).map(([, row]) => row);
  const extraEnvio = [...envio].filter(([id]) => !chain.has(id)).map(([, row]) => row);
  const missingApp = [...envio].filter(([id]) => !app.has(id)).map(([, row]) => row);
  const extraApp = [...app].filter(([id]) => !envio.has(id)).map(([, row]) => row);
  const hashMismatches: ParityReport['hashMismatches'] = [];
  for (const [id, row] of envio) {
    const chainRow = chain.get(id);
    if (chainRow && row.blockHash?.toLowerCase() !== chainRow.blockHash?.toLowerCase()) hashMismatches.push({ layer: 'envio', event: row });
    const appRow = app.get(id);
    if (appRow && appRow.blockHash?.toLowerCase() !== row.blockHash?.toLowerCase()) hashMismatches.push({ layer: 'app', event: appRow });
  }
  const chainBlocks = [...chain.values()].map((row) => row.blockNumber);
  const hasMismatch = [missingEnvio, extraEnvio, missingApp, extraApp, hashMismatches, duplicateKeys].some((rows) => rows.length > 0);
  const finalized = fence >= toBlock + 500n;
  const caughtUp = input.envioWatermark >= toBlock && input.appWatermark >= toBlock;
  return {
    sourceId: source.id, registryVersion: source.registryVersion, fromBlock, toBlock, fence,
    envioWatermark: input.envioWatermark, appWatermark: input.appWatermark, provider: input.provider,
    status: !finalized || !caughtUp ? 'pending' : hasMismatch ? 'mismatch' : 'complete',
    counts: { chain: chain.size, envio: envio.size, app: app.size },
    firstBlock: chainBlocks.length ? chainBlocks.reduce((a, b) => a < b ? a : b) : null,
    lastBlock: chainBlocks.length ? chainBlocks.reduce((a, b) => a > b ? a : b) : null,
    missingEnvio, extraEnvio, missingApp, extraApp, hashMismatches, duplicateKeys,
  };
}

function rowToEvent(row: Record<string, unknown>, source: FactorySource): ParityEvent {
  return {
    chainId: Number(row.chain_id ?? row.chainId), factoryAddress: String(row.factory_address ?? row.factoryAddress ?? source.factory),
    txHash: String(row.tx_hash ?? row.txHash), logIndex: Number(row.log_index ?? row.logIndex),
    blockNumber: BigInt(String(row.block_number ?? row.blockNumber)),
    blockHash: row.block_hash === null || row.blockHash === null ? null : String(row.block_hash ?? row.blockHash),
  };
}

export async function readEnvioLaunchRange(envioPool: Pool, source: FactorySource, fromBlock: bigint, toBlock: bigint): Promise<ParityEvent[]> {
  const table = source.version === 'v2' ? 'envio."RawLaunchV2"' : 'envio."RawLaunch"';
  const filter = source.version === 'v2' ? '' : ' AND lower("factoryAddress") = lower($4)';
  const params = source.version === 'v2' ? [source.chainId, fromBlock.toString(), toBlock.toString()]
    : [source.chainId, fromBlock.toString(), toBlock.toString(), source.factory];
  const rows = await envioPool.query(`SELECT * FROM ${table} WHERE "chainId" = $1
    AND "blockNumber" >= $2 AND "blockNumber" <= $3${filter}
    ORDER BY "blockNumber", "logIndex"`, params);
  return rows.rows.map((row: Record<string, unknown>) => rowToEvent(row, source));
}

export async function readAppLaunchRange(appPool: Pool, source: FactorySource, fromBlock: bigint, toBlock: bigint): Promise<ParityEvent[]> {
  const rows = await appPool.query(`SELECT l.chain_id, l.factory_address, l.launch_tx_hash AS tx_hash,
      l.launch_log_index AS log_index, l.launch_block AS block_number,
      coalesce(l.launch_block_hash, r.block_hash) AS block_hash
    FROM launches l LEFT JOIN raw_logs r ON r.id = l.source_log_id
    WHERE l.chain_id = $1 AND l.source_id = $2 AND lower(l.factory_address) = lower($3)
      AND l.launch_block >= $4 AND l.launch_block <= $5
    ORDER BY l.launch_block, l.launch_log_index`,
  [source.chainId, source.id, source.factory, fromBlock.toString(), toBlock.toString()]);
  return rows.rows.map((row: Record<string, unknown>) => rowToEvent(row, source));
}
