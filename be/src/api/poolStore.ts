import type { Pool } from 'pg';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { quoteFeedRegistry } from '../market/quoteFeedRegistry.js';
import { readPoolCandles, type PoolCandleResponse } from '../pools/candleCache.js';
import { assetDecimals, readPoolStats, readPoolTrades, type PoolStats, type PoolTradeResponse, type PoolKey } from '../pools/stats.js';
import { readPoolDailyHistory, readPoolHistory, type PoolDayHistory } from '../pools/history.js';
import { sumUsdValues } from '../pools/valuation.js';
import { ttlMemo } from './ttlMemo.js';
import { createTokenMetadataResolver, type TokenMetadata } from '../pools/tokenMetadata.js';

export interface PoolSummary extends PoolStats {
  chainId: number; protocol: PoolKey['protocol']; poolId: string;
  currency0: string; currency1: string; displayedToken: string;
  currency0Symbol: string | null; currency0Name: string | null; currency0LogoUri: string | null;
  currency0Decimals: number | null;
  currency1Symbol: string | null; currency1Name: string | null; currency1LogoUri: string | null;
  currency1Decimals: number | null;
  fee: number; tickSpacing: number; hooks: string; createdBlock: string;
  createdTimestamp: number | null;
  ponsDesignated: boolean; launchTokenAddress: string | null;
  /** USD volume over the last 30 UTC days; null when any day is unpriced or the pool is still being indexed. */
  volume30dUsd: string | null;
}
export interface PoolListQuery { limit: number; cursor?: string; chainId?: number; tokenAddress?: string;
  protocol?: PoolKey['protocol']; excludeOfficial?: boolean }
export interface PoolPage { items: PoolSummary[]; nextCursor: string | null; supportedProtocols: readonly string[] }
export interface PoolApiStore {
  listPools(query: PoolListQuery): Promise<PoolPage>;
  getPool(key: PoolKey, displayedToken?: string): Promise<PoolSummary | null>;
  resolvePoolSide(key: PoolKey, displayedToken?: string): Promise<string | null>;
  listPoolTrades(key: PoolKey, displayedToken: string, query: { limit: number; cursor?: string }): Promise<{ items: PoolTradeResponse[]; nextCursor: string | null }>;
  listPoolCandles(key: PoolKey, displayedToken: string, intervalSeconds: number, before?: number): Promise<{ items: PoolCandleResponse[]; complete: boolean }>;
  // Optional so test doubles that predate the daily history keep compiling; the route answers 503 without it.
  listPoolHistory?(key: PoolKey, window: { days: number } | { intervalSeconds: number; buckets: number }): Promise<{ items: PoolDayHistory[]; complete: boolean }>;
}

interface Row { chain_id: number; protocol: PoolKey['protocol']; pool_id: string; currency0: string; currency1: string;
  fee: number; tick_spacing: number; hooks: string; block_number: string; log_index: number;
  launch_token_address: string | null; pons_designated: boolean }
const supportedSourceSql = `(p.protocol='uniswap_v4' OR EXISTS (SELECT 1 FROM pool_source_audits a
  JOIN envio_chain_progress e ON e.chain_id=a.chain_id
  WHERE a.chain_id=p.chain_id AND a.protocol=p.protocol AND a.status='complete'
    AND a.audited_to_block >= GREATEST(0,e.head_block-500)))`;

function decodeCursor(value: string): { block: bigint; log: number; chain: number; protocol: string; poolId: string } {
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(raw) || raw.length !== 5 || typeof raw[0] !== 'string' || !/^\d+$/.test(raw[0])
      || !Number.isSafeInteger(raw[1]) || raw[1] < 0 || !Number.isSafeInteger(raw[2]) || raw[2] < 1
      || !['uniswap_v4', 'uniswap_v3', 'uniswap_v2'].includes(raw[3])
      || typeof raw[4] !== 'string' || !(raw[3] === 'uniswap_v4'
        ? /^0x[0-9a-f]{64}$/.test(raw[4]) : /^0x[0-9a-f]{40}$/.test(raw[4]))) throw new Error('bad');
    return { block: BigInt(raw[0]), log: raw[1] as number, chain: raw[2] as number,
      protocol: raw[3], poolId: raw[4] };
  } catch { throw new Error('Invalid pool cursor'); }
}
function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([String(row.block_number), Number(row.log_index), Number(row.chain_id),
    row.protocol, row.pool_id])).toString('base64url');
}

export function createPoolApiStore(pool: Pool, rpcClient?: UsdPriceClient,
  tokenMetadataResolver = rpcClient ? createTokenMetadataResolver(rpcClient, quoteFeedRegistry) : undefined): PoolApiStore {
  const blockTimeCache = new Map<string, number | null>();
  const emptyMetadata: TokenMetadata = { symbol: null, name: null, logoUri: null };
  async function currencyMetadata(address: string): Promise<TokenMetadata> {
    if (!tokenMetadataResolver) return emptyMetadata;
    try { return await tokenMetadataResolver.resolve(address); } catch { return emptyMetadata; }
  }
  async function createdTimestamp(block: string): Promise<number | null> {
    if (blockTimeCache.has(block)) return blockTimeCache.get(block)!;
    const client = rpcClient as (UsdPriceClient & {
      getBlock?: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> }) | undefined;
    let timestamp: number | null = null;
    if (client?.getBlock) try {
      const value = Number((await client.getBlock({ blockNumber: BigInt(block) })).timestamp);
      if (Number.isSafeInteger(value) && value > 0) timestamp = value;
    } catch { /* Historical block unavailable; leave age unknown. */ }
    if (blockTimeCache.size >= 500) blockTimeCache.clear();
    blockTimeCache.set(block, timestamp);
    return timestamp;
  }
  async function supportedProtocols(chainId?: number): Promise<PoolKey['protocol'][]> {
    const result = await pool.query(`SELECT DISTINCT a.protocol FROM pool_source_audits a
      JOIN envio_chain_progress e ON e.chain_id=a.chain_id
      WHERE a.status='complete' AND a.audited_to_block >= GREATEST(0,e.head_block-500)
        AND ($1::integer IS NULL OR a.chain_id=$1)`, [chainId ?? null]);
    const additional = result.rows.map((row) => String(row.protocol)).filter((value): value is 'uniswap_v3' | 'uniswap_v2' =>
      value === 'uniswap_v3' || value === 'uniswap_v2');
    return ['uniswap_v4', ...additional];
  }
  // 30-day volume needs a per-pool oracle-priced aggregate, so it is cached for a few minutes: a list page
  // asks for up to 100 pools at once and the figure moves slowly.
  const volume30d = ttlMemo(async (cacheKey: string, key?: PoolKey): Promise<string | null> => {
    if (!key) return null;
    try {
      const history = await readPoolDailyHistory(pool, key, { days: 30, asOf: Math.floor(Date.now() / 1000), rpcClient });
      if (!history.complete) return null;
      const days = history.items.map((item) => item.volumeUsd);
      return days.every((value): value is string => value !== null) ? sumUsdValues(days) : null;
    } catch { return null; }
  }, 5 * 60_000);
  async function toSummary(row: Row, token?: string): Promise<PoolSummary> {
    const displayedToken = token ?? row.currency0;
    const key: PoolKey = { chainId: Number(row.chain_id), protocol: row.protocol, poolId: row.pool_id };
    const createdAtPromise = createdTimestamp(String(row.block_number));
    const [stats, volume30dUsd, createdAt, currency0Metadata, currency1Metadata, currency0Decimals, currency1Decimals] = await Promise.all([
      createdAtPromise.then((created) => readPoolStats(pool, key, displayedToken, Math.floor(Date.now() / 1000),
        { rpcClient, createdTimestamp: created })),
      volume30d(`${key.chainId}:${key.protocol}:${key.poolId}`, key),
      createdAtPromise,
      currencyMetadata(row.currency0),
      currencyMetadata(row.currency1),
      assetDecimals(rpcClient, row.currency0),
      assetDecimals(rpcClient, row.currency1),
    ]);
    return { chainId: key.chainId, protocol: key.protocol, poolId: key.poolId,
      currency0: row.currency0, currency1: row.currency1, displayedToken, fee: Number(row.fee),
      currency0Symbol: currency0Metadata.symbol, currency0Name: currency0Metadata.name, currency0LogoUri: currency0Metadata.logoUri,
      currency0Decimals,
      currency1Symbol: currency1Metadata.symbol, currency1Name: currency1Metadata.name, currency1LogoUri: currency1Metadata.logoUri,
      currency1Decimals,
      tickSpacing: Number(row.tick_spacing), hooks: row.hooks, createdBlock: String(row.block_number),
      createdTimestamp: createdAt,
      ponsDesignated: row.pons_designated, launchTokenAddress: row.launch_token_address, volume30dUsd, ...stats };
  }
  const select = `SELECT p.chain_id,p.protocol,p.pool_id,p.currency0,p.currency1,p.fee,p.tick_spacing,p.hooks,
    p.block_number,p.log_index,
    (SELECT l.token_address FROM launches l WHERE l.chain_id=p.chain_id
      AND l.token_address IN (p.currency0,p.currency1) AND l.platform='pons'
      ORDER BY CASE WHEN l.token_address=p.currency0 THEN 0 ELSE 1 END LIMIT 1) AS launch_token_address,
    EXISTS (SELECT 1 FROM venues v WHERE v.chain_id=p.chain_id AND v.kind IN ('v4_pool','v3_pool')
      AND v.ref=p.pool_id AND v.official=true) AS pons_designated
    FROM pool_catalog p`;
  return {
    async listPools(query) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error('Invalid pool limit');
      const supported = await supportedProtocols(query.chainId);
      if (query.protocol && !supported.includes(query.protocol)) throw new Error('Unsupported pool protocol');
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const args: unknown[] = [query.chainId ?? null, query.tokenAddress ?? null, query.protocol ?? null];
      if (cursor) args.push(cursor.block.toString(), cursor.log, cursor.chain, cursor.protocol, cursor.poolId);
      args.push(query.limit + 1);
      const result = await pool.query(`${select}
        WHERE p.verified=true AND ${supportedSourceSql} AND ($1::integer IS NULL OR p.chain_id=$1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM pool_members m WHERE m.chain_id=p.chain_id
          AND m.protocol=p.protocol AND m.pool_id=p.pool_id AND m.token_address=$2))
        AND ($3::text IS NULL OR p.protocol=$3)
        ${query.excludeOfficial ? `AND NOT EXISTS (SELECT 1 FROM venues v WHERE v.chain_id=p.chain_id
          AND v.kind IN ('v4_pool','v3_pool') AND v.ref=p.pool_id AND v.official=true)` : ''}
        ${cursor ? 'AND (p.block_number,p.log_index,p.chain_id,p.protocol,p.pool_id) < ($4::bigint,$5::integer,$6::integer,$7::text,$8::text)' : ''}
        ORDER BY p.block_number DESC,p.log_index DESC,p.chain_id DESC,p.protocol DESC,p.pool_id DESC
        LIMIT $${args.length}`, args);
      const rows = result.rows as Row[];
      const visible = rows.slice(0, query.limit);
      const items = await Promise.all(visible.map((row) => toSummary(row, query.tokenAddress)));
      return { items, nextCursor: rows.length > query.limit && visible.length > 0 ? encodeCursor(visible.at(-1)!) : null,
        supportedProtocols: supported };
    },
    async getPool(key, displayedToken) {
      const result = await pool.query(`${select} WHERE p.chain_id=$1 AND p.protocol=$2 AND p.pool_id=$3 AND p.verified=true
        AND ${supportedSourceSql}`,
        [key.chainId, key.protocol, key.poolId.toLowerCase()]);
      const row = result.rows[0] as Row | undefined;
      if (!row || (displayedToken && displayedToken !== row.currency0 && displayedToken !== row.currency1)) return null;
      return toSummary(row, displayedToken);
    },
    async resolvePoolSide(key, displayedToken) {
      const result = await pool.query(`SELECT p.currency0,p.currency1 FROM pool_catalog p
        WHERE p.chain_id=$1 AND p.protocol=$2 AND p.pool_id=$3 AND p.verified=true AND ${supportedSourceSql}`,
      [key.chainId, key.protocol, key.poolId.toLowerCase()]);
      const row = result.rows[0] as { currency0: string; currency1: string } | undefined;
      if (!row) return null;
      if (displayedToken && displayedToken !== row.currency0 && displayedToken !== row.currency1) return null;
      return displayedToken ?? row.currency0;
    },
    listPoolTrades: (key, token, query) => readPoolTrades(pool, key, token, { ...query, rpcClient }),
    listPoolCandles: (key, token, interval, before) => readPoolCandles(pool, key, token, interval, before, { rpcClient }),
    listPoolHistory: (key, window) => 'days' in window
      ? readPoolDailyHistory(pool, key, { days: window.days, asOf: Math.floor(Date.now() / 1000), rpcClient })
      : readPoolHistory(pool, key, { ...window, asOf: Math.floor(Date.now() / 1000), rpcClient }),
  };
}
