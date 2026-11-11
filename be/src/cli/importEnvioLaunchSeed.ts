import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launches, venues } from '../db/schema.js';
import { ensurePonsSources } from '../envioSync/ensureSources.js';
import { envioRawLaunchToEvent } from '../envioSync/transformV1Legacy.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, resolveKnownQuoteAsset } from '../envioSync/transformV2.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { hydrateV1Launch } from '../launchpads/pons/v1/adapter.js';
import { enqueueFeedResolutionJob } from '../market/quotePricing/priceJobStore.js';

const CHAIN_ID = 4663;
const PAGE_SIZE = 1000;
const FINALITY_DEPTH = 64n;
const CURSOR_TABLE = 'public.pons_launch_seed_import_state';
const V1_FIELDS = 'id chainId tokenAddress deployerAddress pairTokenAddress poolAddress factoryAddress blockNumber blockHash txHash logIndex';
const V2_FIELDS = 'id chainId tokenAddress curveAddress deployerAddress pairTokenAddress blockNumber blockHash txHash logIndex';

interface RawLaunch { id: string; chainId: number; tokenAddress: string; deployerAddress: string; pairTokenAddress: string;
  poolAddress: string; factoryAddress: string; blockNumber: string; blockHash: string; txHash: string; logIndex: number }
interface RawLaunchV2 { id: string; chainId: number; tokenAddress: string; curveAddress: string; deployerAddress: string;
  pairTokenAddress: string; blockNumber: string; blockHash: string; txHash: string; logIndex: number }
interface SeedMeta { chainId: number; progressBlock: string | number; isReady: boolean }
interface Page { v1: RawLaunch[]; v2: RawLaunchV2[]; nextBlock: bigint }

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}
function blockArg(name: string, fallback: bigint): bigint {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a block number`);
  return BigInt(raw);
}
function escapeGraphql(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }

async function graphql<T>(endpoint: string, token: string | undefined, query: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(60_000) });
    if (response.status === 429 && attempt < 6) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : Math.min(60_000, 1000 * 2 ** attempt)));
      continue;
    }
    if (!response.ok) throw new Error(`Seed GraphQL HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const payload = await response.json() as { data?: T; errors?: { message?: string }[] };
    if (payload.errors?.length) throw new Error(`Seed GraphQL: ${payload.errors.map((error) => error.message ?? 'unknown').join('; ')}`);
    if (!payload.data) throw new Error('Seed GraphQL returned no data');
    return payload.data;
  }
}

async function readMeta(endpoint: string, token?: string): Promise<SeedMeta> {
  const data = await graphql<{ _meta: SeedMeta | SeedMeta[] }>(endpoint, token,
    'query SeedProgress { _meta { chainId progressBlock isReady } }');
  const meta = Array.isArray(data._meta) ? data._meta.find((row) => row.chainId === CHAIN_ID) : data._meta;
  if (!meta || meta.chainId !== CHAIN_ID) throw new Error('Seed deployment metadata for chain 4663 is unavailable');
  return meta;
}

async function fetchBoundary<T extends { id: string }>(endpoint: string, token: string | undefined, entity: 'RawLaunch' | 'RawLaunchV2',
  fields: string, block: bigint): Promise<T[]> {
  const result: T[] = [];
  let afterId = '';
  while (true) {
    const page = await graphql<Record<string, T[]>>(endpoint, token,
      `query LaunchBoundary { ${entity}(where:{chainId:{_eq:${CHAIN_ID}},blockNumber:{_eq:"${block}",_lte:"${block}"},id:{_gt:"${escapeGraphql(afterId)}"}},order_by:{id:asc},limit:${PAGE_SIZE}) { ${fields} } }`);
    const rows = page[entity] ?? [];
    result.push(...rows);
    if (rows.length < PAGE_SIZE) return result;
    const next = rows.at(-1)?.id;
    if (!next || next <= afterId) throw new Error(`Seed boundary pagination did not advance for ${entity} at ${block}`);
    afterId = next;
  }
}

async function fetchPage(endpoint: string, token: string | undefined, fromBlock: bigint, fence: bigint): Promise<Page> {
  const [v1Result, v2Result] = await Promise.all([
    graphql<{ RawLaunch: RawLaunch[] }>(endpoint, token,
      `query V1LaunchSeedPage { RawLaunch(where:{chainId:{_eq:${CHAIN_ID}},blockNumber:{_gt:"${fromBlock - 1n}",_lte:"${fence}"}},order_by:{blockNumber:asc},limit:${PAGE_SIZE}) { ${V1_FIELDS} } }`),
    graphql<{ RawLaunchV2: RawLaunchV2[] }>(endpoint, token,
      `query V2LaunchSeedPage { RawLaunchV2(where:{chainId:{_eq:${CHAIN_ID}},blockNumber:{_gt:"${fromBlock - 1n}",_lte:"${fence}"}},order_by:{blockNumber:asc},limit:${PAGE_SIZE}) { ${V2_FIELDS} } }`),
  ]);
  let v1 = v1Result.RawLaunch ?? [];
  let v2 = v2Result.RawLaunchV2 ?? [];
  const full = [
    ...(v1.length === PAGE_SIZE && v1.at(-1) ? [{ entity: 'RawLaunch' as const, block: BigInt(v1.at(-1)!.blockNumber) }] : []),
    ...(v2.length === PAGE_SIZE && v2.at(-1) ? [{ entity: 'RawLaunchV2' as const, block: BigInt(v2.at(-1)!.blockNumber) }] : []),
  ];
  if (full.length) {
    const boundaryBlock = full.reduce((min, item) => item.block < min ? item.block : min, full[0]!.block);
    const v1Boundary = v1.length === PAGE_SIZE && BigInt(v1.at(-1)!.blockNumber) === boundaryBlock
      ? await fetchBoundary<RawLaunch>(endpoint, token, 'RawLaunch', V1_FIELDS, boundaryBlock) : null;
    const v2Boundary = v2.length === PAGE_SIZE && BigInt(v2.at(-1)!.blockNumber) === boundaryBlock
      ? await fetchBoundary<RawLaunchV2>(endpoint, token, 'RawLaunchV2', V2_FIELDS, boundaryBlock) : null;
    if (v1Boundary) v1 = [...v1.filter((row) => BigInt(row.blockNumber) < boundaryBlock), ...v1Boundary];
    if (v2Boundary) v2 = [...v2.filter((row) => BigInt(row.blockNumber) < boundaryBlock), ...v2Boundary];
    return { v1, v2, nextBlock: boundaryBlock + 1n };
  }
  return { v1, v2, nextBlock: fence + 1n };
}

async function ensureCursor(pool: Pool, key: string, start: bigint, end: bigint): Promise<bigint> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (
    deployment_key text PRIMARY KEY, start_block numeric NOT NULL, end_block numeric NOT NULL,
    next_block numeric NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`INSERT INTO ${CURSOR_TABLE}(deployment_key,start_block,end_block,next_block) VALUES($1,$2,$3,$2)
    ON CONFLICT(deployment_key) DO NOTHING`, [key, start.toString(), end.toString()]);
  const result = await pool.query(`SELECT start_block,end_block,next_block FROM ${CURSOR_TABLE} WHERE deployment_key=$1`, [key]);
  const row = result.rows[0] as { start_block: string; end_block: string; next_block: string } | undefined;
  if (!row || BigInt(row.start_block) !== start || BigInt(row.end_block) !== end) {
    throw new Error('Existing launch seed cursor has a different range; use the same range or a new seed endpoint');
  }
  return BigInt(row.next_block);
}

async function saveCursor(pool: Pool, key: string, next: bigint): Promise<void> {
  await pool.query(`UPDATE ${CURSOR_TABLE} SET next_block=$2,updated_at=now() WHERE deployment_key=$1`, [key, next.toString()]);
}

async function importPage(db: ReturnType<typeof createDatabase>['db'], pool: Pool, v1Rows: RawLaunch[], v2Rows: RawLaunchV2[]): Promise<number> {
  const v1ByFactory = new Map(getPonsFactorySources().filter((factory) => factory.version === 'v1')
    .map((factory) => [factory.factory.toLowerCase(), factory]));
  const v2Factory = getPonsFactorySources().find((factory) => factory.version === 'v2')!;
  const launchRows: (typeof launches.$inferInsert)[] = [];
  const venueRows: (typeof venues.$inferInsert)[] = [];
  const quoteAssets = new Set<string>();
  const tokenAddresses = new Set<string>();
  let insertedLaunches = 0;
  for (const raw of v1Rows) {
    const factory = v1ByFactory.get(raw.factoryAddress.toLowerCase());
    if (!factory) throw new Error(`Unregistered Pons V1 factory ${raw.factoryAddress}`);
    const event = envioRawLaunchToEvent({ ...raw, blockNumber: BigInt(raw.blockNumber) });
    const { launch, venue } = hydrateV1Launch(event, factory, null, null);
    const token = launch.tokenAddress.toLowerCase();
    if (!tokenAddresses.has(token)) {
      tokenAddresses.add(token);
      launchRows.push({ chainId: launch.chainId, tokenAddress: token, sourceId: launch.sourceId, sourceLogId: null,
        name: null, symbol: null, tokenDecimals: null, platform: launch.platform, protocolVersion: launch.protocolVersion,
        factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
        launchBlockHash: raw.blockHash, launchTxHash: launch.launchTxHash, launchLogIndex: raw.logIndex,
        quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
        quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus });
      quoteAssets.add(launch.quoteAsset.address.toLowerCase());
    }
    venueRows.push({ id: venue.id, chainId: venue.chainId, tokenAddress: token, kind: venue.kind, ref: venue.ref,
      sourceId: `${factory.id}-trades`, sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: venue.official });
  }
  for (const raw of v2Rows) {
    const event = envioRawLaunchV2ToEvent({ ...raw, blockNumber: BigInt(raw.blockNumber) });
    const knownQuote = resolveKnownQuoteAsset(event.pairToken);
    const { launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory, null,
      { address: event.pairToken, symbol: knownQuote?.symbol ?? null, decimals: knownQuote?.decimals ?? null });
    const token = launch.tokenAddress.toLowerCase();
    if (!tokenAddresses.has(token)) {
      tokenAddresses.add(token);
      launchRows.push({ chainId: launch.chainId, tokenAddress: token, sourceId: launch.sourceId, sourceLogId: null,
        name: null, symbol: null, tokenDecimals: null, platform: launch.platform, protocolVersion: launch.protocolVersion,
        factoryAddress: launch.factoryAddress, deployerAddress: launch.deployerAddress, launchBlock: launch.launchBlock,
        launchBlockHash: raw.blockHash, launchTxHash: launch.launchTxHash, launchLogIndex: raw.logIndex,
        quoteAssetAddress: launch.quoteAsset.address, quoteAssetSymbol: launch.quoteAsset.symbol,
        quoteAssetDecimals: launch.quoteAsset.decimals, lifecycleStatus: launch.lifecycleStatus });
      quoteAssets.add(launch.quoteAsset.address.toLowerCase());
    }
    venueRows.push({ id: venue.id, chainId: venue.chainId, tokenAddress: token, kind: venue.kind, ref: venue.ref,
      sourceId: 'pons-v2-curve', sourceLogId: null, effectiveFromBlock: venue.effectiveFromBlock, official: true });
  }
  if (launchRows.length || venueRows.length) {
    await db.transaction(async (tx) => {
      if (launchRows.length) {
        const inserted = await tx.insert(launches).values(launchRows).onConflictDoNothing().returning({ tokenAddress: launches.tokenAddress });
        insertedLaunches = inserted.length;
      }
      if (venueRows.length) await tx.insert(venues).values(venueRows).onConflictDoNothing();
    });
  }
  for (const quoteAddress of quoteAssets) await enqueueFeedResolutionJob(pool, CHAIN_ID, quoteAddress);
  return insertedLaunches;
}

const endpoint = arg('--graphql-url');
if (!endpoint) throw new Error('--graphql-url is required');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const token = arg('--token');
const startBlock = blockArg('--start-block', 8_600_612n);
const endBlock = blockArg('--end-block', 111_688_686n);
if (endBlock < startBlock) throw new Error('--end-block must be at least --start-block');
const pollMs = Number(arg('--poll-ms') ?? 5000);
if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 300_000) throw new Error('--poll-ms must be 1000–300000');
const { db, pool } = createDatabase(databaseUrl);
const endpointKey = createHash('sha256').update(endpoint).digest('hex');
try {
  await ensurePonsSources(db, CHAIN_ID, startBlock);
  let nextBlock = await ensureCursor(pool, endpointKey, startBlock, endBlock);
  let imported = 0;
  while (true) {
    const meta = await readMeta(endpoint, token);
    const progress = BigInt(meta.progressBlock);
    const fence = meta.isReady && progress >= endBlock ? endBlock
      : progress > FINALITY_DEPTH ? (progress - FINALITY_DEPTH < endBlock ? progress - FINALITY_DEPTH : endBlock) : 0n;
    while (nextBlock <= fence) {
      const page = await fetchPage(endpoint, token, nextBlock, fence);
      const count = await importPage(db, pool, page.v1, page.v2);
      imported += count;
      nextBlock = page.nextBlock;
      await saveCursor(pool, endpointKey, nextBlock);
      console.log(`Launch seed page: v1=${page.v1.length}, v2=${page.v2.length}, launches=${count}, nextBlock=${nextBlock}`);
    }
    if (meta.isReady && progress >= endBlock && nextBlock > endBlock) {
      console.log(`Launch seed import complete through block ${endBlock}; launches inserted=${imported}`);
      break;
    }
    if (!process.argv.includes('--watch')) {
      console.log(`Seed still indexing: progress=${progress}, nextBlock=${nextBlock}, endBlock=${endBlock}. Re-run with --watch to wait.`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} finally {
  await pool.end();
}
