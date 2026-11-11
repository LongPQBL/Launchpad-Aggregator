import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { poolCatalog, poolMembers } from '../db/schema.js';
import { verifyV2PairCreated, verifyV3PoolCreated, V2_FACTORY, V3_FACTORY } from './sourceRegistry.js';
import { verifyV4Initialize } from './identity.js';

const CHAIN_ID = 4663;
const PAGE_SIZE = 1000;
const WINDOW_BLOCKS = 5_000_000n;
const WRITE_BATCH_SIZE = 1000;
const WINDOW_CONCURRENCY = 4;
const FINALITY_DEPTH = 64n;
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const SEED_QUERY_FIELDS = 'id chainId kind poolAddress sourceAddress currency0 currency1 fee tickSpacing hooks blockNumber blockHash txHash logIndex';
const CURSOR_TABLE = 'public.pool_seed_import_state';

export interface SeededPoolRow {
  id: string;
  chainId: number;
  kind: string;
  poolAddress: string;
  sourceAddress: string;
  currency0: string | null;
  currency1: string | null;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  txHash: string | null;
  logIndex: number | null;
}

export interface SeedImportResult {
  fetched: number;
  imported: number;
  skippedPonsV1: number;
  windows: number;
  nextBlock: bigint;
  progressBlock: bigint;
  complete: boolean;
}

interface SeedMeta { chainId: number; progressBlock: string | number; isReady: boolean }

async function graphql<T>(endpoint: string, bearerToken: string | undefined, query: string): Promise<T> {
  const bodyText = JSON.stringify({ query });
  let body: { data?: T; errors?: { message?: string }[] } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) },
        body: bodyText,
      });
      if (!response.ok) {
        if (response.status !== 429 && response.status < 500) throw new Error(`Seed GraphQL returned HTTP ${response.status}`);
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : 500 * (2 ** attempt);
        if (attempt === 4) throw new Error(`Seed GraphQL returned HTTP ${response.status} after retries`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      body = await response.json() as { data?: T; errors?: { message?: string }[] };
      break;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Seed GraphQL returned HTTP 4')) throw error;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  if (!body) throw new Error('Seed GraphQL request returned no response');
  if (body.errors?.length) throw new Error(`Seed GraphQL error: ${body.errors.map((error) => error.message ?? 'unknown').join('; ')}`);
  if (!body.data) throw new Error('Seed GraphQL response did not contain data');
  return body.data;
}

async function readMeta(endpoint: string, bearerToken: string | undefined): Promise<SeedMeta> {
  const data = await graphql<{ _meta: SeedMeta | SeedMeta[] }>(endpoint, bearerToken,
    'query SeedProgress { _meta { chainId progressBlock isReady } }');
  const meta = Array.isArray(data._meta) ? data._meta.find((row) => row.chainId === CHAIN_ID) : data._meta;
  if (!meta || meta.chainId !== CHAIN_ID) throw new Error('Seed deployment metadata for chain 4663 is unavailable');
  return meta;
}

async function ensureCursor(pool: Pool, deploymentKey: string, startBlock: bigint, endBlock: bigint): Promise<bigint> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (
    deployment_key text PRIMARY KEY,
    start_block numeric NOT NULL,
    end_block numeric NOT NULL,
    next_block numeric NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`INSERT INTO ${CURSOR_TABLE} (deployment_key,start_block,end_block,next_block)
    VALUES ($1,$2,$3,$2) ON CONFLICT (deployment_key) DO NOTHING`, [deploymentKey, startBlock.toString(), endBlock.toString()]);
  const result = await pool.query(`SELECT start_block,end_block,next_block FROM ${CURSOR_TABLE} WHERE deployment_key=$1`, [deploymentKey]);
  const row = result.rows[0] as { start_block: string; end_block: string; next_block: string } | undefined;
  if (!row) throw new Error('Could not initialize Envio seed import cursor');
  if (BigInt(row.start_block) !== startBlock || BigInt(row.end_block) !== endBlock) {
    throw new Error('Existing seed cursor has a different block range; use a new seed deployment endpoint or reset its cursor');
  }
  return BigInt(row.next_block);
}

async function saveCursor(pool: Pool, deploymentKey: string, nextBlock: bigint): Promise<void> {
  await pool.query(`UPDATE ${CURSOR_TABLE} SET next_block=$2,updated_at=now() WHERE deployment_key=$1`,
    [deploymentKey, nextBlock.toString()]);
}

async function fetchBlock(endpoint: string, bearerToken: string | undefined, block: bigint): Promise<SeededPoolRow[]> {
  const rows: SeededPoolRow[] = [];
  let afterId = '';
  while (true) {
    const idFilter = afterId ? `,id:{_gt:${JSON.stringify(afterId)}}` : '';
    const data = await graphql<{ SeededPool: SeededPoolRow[] }>(endpoint, bearerToken,
      `query SeedBlock { SeededPool(where:{chainId:{_eq:${CHAIN_ID}},blockNumber:{_eq:"${block}"}${idFilter}},order_by:{id:asc},limit:${PAGE_SIZE}) { ${SEED_QUERY_FIELDS} } }`);
    const page = data.SeededPool;
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    const nextId = page.at(-1)!.id;
    if (nextId <= afterId) throw new Error(`Seed GraphQL block pagination did not advance at block ${block}`);
    afterId = nextId;
  }
}

/** Split dense block windows until each GraphQL query is guaranteed to have returned all rows. */
async function fetchWindow(endpoint: string, bearerToken: string | undefined, fromBlock: bigint,
  toBlock: bigint): Promise<SeededPoolRow[]> {
  const data = await graphql<{ SeededPool: SeededPoolRow[] }>(endpoint, bearerToken,
    `query SeedWindow { SeededPool(where:{chainId:{_eq:${CHAIN_ID}},blockNumber:{_gte:"${fromBlock}",_lte:"${toBlock}"}},order_by:{blockNumber:asc},limit:${PAGE_SIZE}) { ${SEED_QUERY_FIELDS} } }`);
  if (data.SeededPool.length < PAGE_SIZE) return data.SeededPool;
  if (fromBlock === toBlock) return fetchBlock(endpoint, bearerToken, fromBlock);
  const middle = (fromBlock + toBlock) / 2n;
  const [left, right] = await Promise.all([
    fetchWindow(endpoint, bearerToken, fromBlock, middle),
    fetchWindow(endpoint, bearerToken, middle + 1n, toBlock),
  ]);
  return [...left, ...right];
}

function required<T>(value: T | null | undefined, field: string, row: SeededPoolRow): T {
  if (value === null || value === undefined) throw new Error(`Seed row ${row.id} is missing ${field}`);
  return value;
}

type VerifiedCatalogPool = NonNullable<ReturnType<typeof verifyV2PairCreated>>
  | NonNullable<ReturnType<typeof verifyV4Initialize>>;

function verifySeedRow(row: SeededPoolRow): VerifiedCatalogPool | null {
  if (row.chainId !== CHAIN_ID) throw new Error(`Unexpected chain ${row.chainId} in seed row ${row.id}`);
  // Pons V1's launch pool is already registered as the launch's official venue by launch sync.
  if (row.kind === 'pons_v1') return null;
  const common = {
    chainId: row.chainId,
    token0: required(row.currency0, 'currency0', row),
    token1: required(row.currency1, 'currency1', row),
    blockNumber: BigInt(required(row.blockNumber, 'blockNumber', row)),
    blockHash: required(row.blockHash, 'blockHash', row),
    txHash: required(row.txHash, 'txHash', row),
    logIndex: required(row.logIndex, 'logIndex', row),
  };
  if (row.kind === 'uniswap_v2' || row.kind === 'uniswap_v3') {
    const protocol = row.kind;
    const expectedFactory = protocol === 'uniswap_v2' ? V2_FACTORY : V3_FACTORY;
    if (row.sourceAddress.toLowerCase() !== expectedFactory) throw new Error(`Unexpected factory in seed row ${row.id}`);
    const verified = protocol === 'uniswap_v2'
      ? verifyV2PairCreated({ ...common, factoryAddress: row.sourceAddress, pairAddress: row.poolAddress })
      : verifyV3PoolCreated({ ...common, factoryAddress: row.sourceAddress, poolAddress: row.poolAddress,
        fee: required(row.fee, 'fee', row), tickSpacing: required(row.tickSpacing, 'tickSpacing', row) });
    if (!verified) throw new Error(`Seed row failed ${protocol} factory-event verification: ${row.id}`);
    return verified;
  }
  if (row.kind === 'uniswap_v4') {
    if (row.sourceAddress.toLowerCase() !== POOL_MANAGER) throw new Error(`Unexpected PoolManager in seed row ${row.id}`);
    const verified = verifyV4Initialize({ chainId: row.chainId, poolId: row.poolAddress,
      currency0: common.token0, currency1: common.token1,
      fee: required(row.fee, 'fee', row), tickSpacing: required(row.tickSpacing, 'tickSpacing', row),
      hooks: required(row.hooks, 'hooks', row), blockNumber: common.blockNumber,
      blockHash: common.blockHash, txHash: common.txHash, logIndex: common.logIndex });
    if (!verified) throw new Error(`Seed row failed V4 Pool ID verification: ${row.id}`);
    return verified;
  }
  throw new Error(`Unknown seed pool kind ${row.kind} in row ${row.id}`);
}

async function importBatch(db: Database, rows: SeededPoolRow[]): Promise<{ imported: number; skipped: number }> {
  const verified: VerifiedCatalogPool[] = [];
  let skipped = 0;
  for (const row of rows) {
    const pool = verifySeedRow(row);
    if (pool) verified.push(pool);
    else skipped += 1;
  }
  if (verified.length === 0) return { imported: 0, skipped };
  await db.transaction(async (tx) => {
    for (const protocol of ['uniswap_v2', 'uniswap_v3', 'uniswap_v4'] as const) {
      const protocolPools = verified.filter((pool) => pool.protocol === protocol);
      if (!protocolPools.length) continue;
      await tx.insert(poolCatalog).values(protocolPools.map((pool) => ({ ...pool, coverageStatus: 'incomplete' })))
        .onConflictDoNothing();
      await tx.insert(poolMembers).values(protocolPools.flatMap((pool) => [pool.currency0, pool.currency1].map((tokenAddress) => ({
        chainId: pool.chainId, protocol, poolId: pool.poolId, tokenAddress,
      })))).onConflictDoNothing();
    }
  });
  return { imported: verified.length, skipped };
}

/** Imports each finalized seed block once; safe to call repeatedly while Envio Cloud is still indexing. */
export async function importEnvioPoolSeed(db: Database, appPool: Pool, endpoint: string, options: {
  bearerToken?: string;
  startBlock: bigint;
  endBlock: bigint;
  onProgress?: (result: SeedImportResult) => void;
}): Promise<SeedImportResult> {
  if (options.startBlock < 0n || options.endBlock < options.startBlock) throw new Error('Invalid seed block range');
  const deploymentKey = createHash('sha256').update(endpoint).digest('hex');
  let nextBlock = await ensureCursor(appPool, deploymentKey, options.startBlock, options.endBlock);
  const meta = await readMeta(endpoint, options.bearerToken);
  let progressBlock = BigInt(meta.progressBlock);
  // Leave a finality buffer while the indexer is live so incomplete/reorgable blocks are not imported.
  const fence = meta.isReady && progressBlock >= options.endBlock
    ? options.endBlock
    : progressBlock > FINALITY_DEPTH ? progressBlock - FINALITY_DEPTH : 0n;
  const result: SeedImportResult = { fetched: 0, imported: 0, skippedPonsV1: 0,
    windows: 0, nextBlock, progressBlock, complete: false };

  while (nextBlock <= options.endBlock && nextBlock <= fence) {
    const windows: { from: bigint; to: bigint }[] = [];
    let windowStart = nextBlock;
    while (windows.length < WINDOW_CONCURRENCY && windowStart <= fence && windowStart <= options.endBlock) {
      const windowEnd = [windowStart + WINDOW_BLOCKS - 1n, fence, options.endBlock].reduce((a, b) => a < b ? a : b);
      windows.push({ from: windowStart, to: windowEnd });
      windowStart = windowEnd + 1n;
    }
    // Fetch independent block windows concurrently, then bulk-write them concurrently. The
    // checkpoint advances only after every window in this contiguous batch commits.
    const rowsByWindow = await Promise.all(windows.map(({ from, to }) =>
      fetchWindow(endpoint, options.bearerToken, from, to)));
    const countsByWindow = await Promise.all(rowsByWindow.map(async (rows) => {
      let imported = 0;
      let skipped = 0;
      for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
        const counts = await importBatch(db, rows.slice(offset, offset + WRITE_BATCH_SIZE));
        imported += counts.imported;
        skipped += counts.skipped;
      }
      return { rows: rows.length, imported, skipped };
    }));
    result.fetched += countsByWindow.reduce((sum, counts) => sum + counts.rows, 0);
    result.imported += countsByWindow.reduce((sum, counts) => sum + counts.imported, 0);
    result.skippedPonsV1 += countsByWindow.reduce((sum, counts) => sum + counts.skipped, 0);
    result.windows += windows.length;
    nextBlock = windows.at(-1)!.to + 1n;
    await saveCursor(appPool, deploymentKey, nextBlock);
    result.nextBlock = nextBlock;
    options.onProgress?.({ ...result });
  }
  // Completion is reported only when Cloud's ready metadata confirms it reached the fixed end block.
  result.complete = meta.isReady && progressBlock >= options.endBlock && nextBlock > options.endBlock;
  return result;
}

export const ENVIO_POOL_SEED_RANGE = { startBlock: 8_600_612n, endBlock: 111_584_773n } as const;
