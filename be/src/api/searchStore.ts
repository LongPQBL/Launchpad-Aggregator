import type { Pool } from 'pg';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { readPoolStats } from '../pools/stats.js';
import { createTokenMetadataResolver } from '../pools/tokenMetadata.js';
import { quoteFeedRegistry } from '../market/quoteFeedRegistry.js';
import { readLaunchStats } from './launchStatsStore.js';
import { ttlMemo } from './ttlMemo.js';
import { launchCoverageSql, readSafeHead } from '../coverage/launchCoverageSql.js';

export interface SearchTokenHit {
  chainId: number; tokenAddress: string; name: string | null; symbol: string | null; logoUri: string | null; platform: string;
  priceUsd: string | null; change1d: string | null;
}
export interface SearchPoolHit {
  chainId: number; protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string; fee: number;
  currency0: string; currency1: string;
  // The launched token that made this pool relevant (every indexed pool has at least one) — what
  // the UI labels the hit with and links the pool page's displayed side to.
  launchToken: { address: string; name: string | null; symbol: string | null; logoUri: string | null };
  currency0Symbol: string | null; currency0LogoUri: string | null;
  currency1Symbol: string | null; currency1LogoUri: string | null;
  volume24hUsd: string | null;
  ponsDesignated: boolean;
}
export interface SearchResults { tokens: SearchTokenHit[]; pools: SearchPoolHit[] }
export interface SearchStore { search(query: string, limit: number, chainIds?: readonly number[], offset?: number): Promise<SearchResults> }

export const MIN_SEARCH_LENGTH = 0;

// `%`, `_` and `\` are LIKE wildcards: a user typing "50%" must match the literal text, not "50<anything>".
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function createSearchStore(pool: Pool, rpcClient?: UsdPriceClient): SearchStore {
  const resolver = rpcClient ? createTokenMetadataResolver(rpcClient, quoteFeedRegistry) : undefined;
  const metadata = async (address: string, symbol: string | null, logoUri: string | null) => {
    if (symbol) return { symbol, logoUri };
    if (!resolver) return { symbol: address === '0x0000000000000000000000000000000000000000' ? 'ETH' : null, logoUri };
    try { const resolved = await resolver.resolve(address); return { symbol: resolved.symbol, logoUri: logoUri ?? resolved.logoUri }; }
    catch { return { symbol: null, logoUri }; }
  };
  const poolVolume = ttlMemo(async (_key: string, hit: SearchPoolHit) => {
    try {
      return (await readPoolStats(pool, { chainId: hit.chainId, protocol: hit.protocol, poolId: hit.poolId },
        hit.launchToken.address, Math.floor(Date.now() / 1000), { rpcClient })).volume24hUsd;
    } catch { return null; }
  }, 30_000);
  return {
    async search(rawQuery: string, limit: number, chainIds?: readonly number[], offset = 0): Promise<SearchResults> {
      const query = rawQuery.trim();
      const browsing = query.length === 0;
      const contains = query.length === 1 ? `${escapeLike(query)}%` : `%${escapeLike(query)}%`;
      const prefix = `${escapeLike(query)}%`;
      const lowered = query.toLowerCase();
      const tokenAddress = ADDRESS_PATTERN.test(query) ? lowered : null;
      const poolId = ADDRESS_PATTERN.test(query) || POOL_ID_PATTERN.test(query) ? lowered : null;
      const safeHead = await readSafeHead(pool);

      // Exact symbol first, then prefix matches, then anything containing the text; newest first within a tier.
      const matchRank = `CASE WHEN lower(l.symbol) = $4 THEN 0 WHEN l.symbol ILIKE $3 OR l.name ILIKE $3 THEN 1 ELSE 2 END`;
      const launchMatch = `(l.name ILIKE $1 OR l.symbol ILIKE $1 OR l.token_address = $5)`;

      const [tokens, pools] = await Promise.all([
        pool.query(`SELECT l.chain_id, l.token_address, l.name, l.symbol, l.logo_uri, l.platform,
            ${launchCoverageSql(7)} AS coverage_complete FROM launches l
          WHERE ($8::boolean OR ${launchMatch}) AND ($6::integer[] IS NULL OR l.chain_id = ANY($6))
          ORDER BY CASE WHEN $8::boolean THEN 0 ELSE ${matchRank} END, l.launch_block DESC, l.chain_id, l.token_address
          LIMIT $2 OFFSET $9`,
        [contains, limit, prefix, lowered, tokenAddress, chainIds ?? null, safeHead?.toString() ?? null, browsing, offset]),
        pool.query(`SELECT * FROM (SELECT DISTINCT ON (pc.chain_id, pc.protocol, pc.pool_id)
            pc.chain_id, pc.protocol, pc.pool_id, pc.fee, pc.currency0, pc.currency1, pc.block_number AS sort_block,
            l.token_address, l.name, l.symbol, l.logo_uri,
            CASE WHEN $8::boolean THEN 0 ELSE ${matchRank} END AS match_rank,
            COALESCE(c0.symbol, CASE WHEN pc.currency0 = l.quote_asset_address THEN l.quote_asset_symbol END) AS currency0_symbol,
            c0.logo_uri AS currency0_logo_uri,
            COALESCE(c1.symbol, CASE WHEN pc.currency1 = l.quote_asset_address THEN l.quote_asset_symbol END) AS currency1_symbol,
            c1.logo_uri AS currency1_logo_uri,
            EXISTS (SELECT 1 FROM venues v WHERE v.chain_id=pc.chain_id AND v.ref=pc.pool_id
              AND v.kind IN ('v3_pool','v4_pool') AND v.official=true) AS pons_designated
          FROM pool_catalog pc
          JOIN pool_members m ON m.chain_id = pc.chain_id AND m.protocol = pc.protocol AND m.pool_id = pc.pool_id
          JOIN launches l ON l.chain_id = m.chain_id AND l.token_address = m.token_address
          LEFT JOIN launches c0 ON c0.chain_id = pc.chain_id AND c0.token_address = pc.currency0
          LEFT JOIN launches c1 ON c1.chain_id = pc.chain_id AND c1.token_address = pc.currency1
          WHERE pc.verified = true AND ($8::boolean OR ${launchMatch} OR pc.pool_id = $6)
            AND ($7::integer[] IS NULL OR pc.chain_id = ANY($7))
          ORDER BY pc.chain_id, pc.protocol, pc.pool_id, match_rank, l.launch_block DESC
          ) ranked ORDER BY match_rank, sort_block DESC, chain_id, protocol, pool_id LIMIT $2 OFFSET $9`,
        [contains, limit, prefix, lowered, tokenAddress, poolId, chainIds ?? null, browsing, offset]),
      ]);

      const stats = await readLaunchStats(pool, tokens.rows.map((row) => ({ chainId: Number(row.chain_id), tokenAddress: String(row.token_address) })));

      const seen = new Set<string>();
      const poolHits: SearchPoolHit[] = [];
      for (const row of pools.rows) {
        const key = `${row.chain_id}:${row.protocol}:${row.pool_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        poolHits.push({
          chainId: Number(row.chain_id), protocol: row.protocol, poolId: String(row.pool_id), fee: Number(row.fee),
          currency0: String(row.currency0), currency1: String(row.currency1),
          launchToken: { address: String(row.token_address), name: row.name ?? null, symbol: row.symbol ?? null, logoUri: row.logo_uri ?? null },
          currency0Symbol: row.currency0_symbol ?? null, currency0LogoUri: row.currency0_logo_uri ?? null,
          currency1Symbol: row.currency1_symbol ?? null, currency1LogoUri: row.currency1_logo_uri ?? null,
          volume24hUsd: null,
          ponsDesignated: Boolean(row.pons_designated),
        });
        if (poolHits.length === limit) break;
      }
      await Promise.all(poolHits.map(async (hit) => {
        const [currency0, currency1, volume] = await Promise.all([
          metadata(hit.currency0, hit.currency0Symbol, hit.currency0LogoUri),
          metadata(hit.currency1, hit.currency1Symbol, hit.currency1LogoUri),
          poolVolume(`${hit.chainId}:${hit.protocol}:${hit.poolId}`, hit),
        ]);
        hit.currency0Symbol = currency0.symbol ?? hit.currency0Symbol;
        hit.currency0LogoUri = currency0.logoUri ?? null;
        hit.currency1Symbol = currency1.symbol ?? hit.currency1Symbol;
        hit.currency1LogoUri = currency1.logoUri ?? null;
        hit.volume24hUsd = volume;
      }));
      return {
        tokens: tokens.rows.map((row) => ({
          chainId: Number(row.chain_id), tokenAddress: String(row.token_address), name: row.name ?? null, symbol: row.symbol ?? null,
          logoUri: row.logo_uri ?? null, platform: String(row.platform),
          priceUsd: row.coverage_complete ? stats.get(`${row.chain_id}:${row.token_address}`)?.priceUsd ?? null : null,
          change1d: row.coverage_complete ? stats.get(`${row.chain_id}:${row.token_address}`)?.change1d ?? null : null,
        })),
        pools: poolHits,
      };
    },
  };
}
