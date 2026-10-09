import type { Pool } from 'pg';

export interface SearchTokenHit {
  chainId: number; tokenAddress: string; name: string | null; symbol: string | null; logoUri: string | null; platform: string;
}
export interface SearchPoolHit {
  chainId: number; protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string; fee: number;
  currency0: string; currency1: string;
  // The launched token that made this pool relevant (every indexed pool has at least one) — what
  // the UI labels the hit with and links the pool page's displayed side to.
  launchToken: { address: string; name: string | null; symbol: string | null; logoUri: string | null };
}
export interface SearchResults { tokens: SearchTokenHit[]; pools: SearchPoolHit[] }
export interface SearchStore { search(query: string, limit: number): Promise<SearchResults> }

export const MIN_SEARCH_LENGTH = 2;

// `%`, `_` and `\` are LIKE wildcards: a user typing "50%" must match the literal text, not "50<anything>".
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function createSearchStore(pool: Pool): SearchStore {
  return {
    async search(rawQuery: string, limit: number): Promise<SearchResults> {
      const query = rawQuery.trim();
      if (query.length < MIN_SEARCH_LENGTH) return { tokens: [], pools: [] };
      const contains = `%${escapeLike(query)}%`;
      const prefix = `${escapeLike(query)}%`;
      const lowered = query.toLowerCase();
      const tokenAddress = ADDRESS_PATTERN.test(query) ? lowered : null;
      const poolId = ADDRESS_PATTERN.test(query) || POOL_ID_PATTERN.test(query) ? lowered : null;

      // Exact symbol first, then prefix matches, then anything containing the text; newest first within a tier.
      const matchRank = `CASE WHEN lower(l.symbol) = $4 THEN 0 WHEN l.symbol ILIKE $3 OR l.name ILIKE $3 THEN 1 ELSE 2 END`;
      const launchMatch = `(l.name ILIKE $1 OR l.symbol ILIKE $1 OR l.token_address = $5)`;

      const [tokens, pools] = await Promise.all([
        pool.query(`SELECT l.chain_id, l.token_address, l.name, l.symbol, l.logo_uri, l.platform FROM launches l
          WHERE ${launchMatch} ORDER BY ${matchRank}, l.launch_block DESC LIMIT $2`,
        [contains, limit, prefix, lowered, tokenAddress]),
        pool.query(`SELECT pc.chain_id, pc.protocol, pc.pool_id, pc.fee, pc.currency0, pc.currency1,
            l.token_address, l.name, l.symbol, l.logo_uri
          FROM pool_catalog pc
          JOIN pool_members m ON m.chain_id = pc.chain_id AND m.protocol = pc.protocol AND m.pool_id = pc.pool_id
          JOIN launches l ON l.chain_id = m.chain_id AND l.token_address = m.token_address
          WHERE pc.verified = true AND (${launchMatch} OR pc.pool_id = $6)
          ORDER BY ${matchRank}, pc.block_number DESC LIMIT $2`,
        // A pool whose two members are both launches matches twice; fetch extra so de-duplication can still fill `limit`.
        [contains, limit * 2, prefix, lowered, tokenAddress, poolId]),
      ]);

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
        });
        if (poolHits.length === limit) break;
      }
      return {
        tokens: tokens.rows.map((row) => ({
          chainId: Number(row.chain_id), tokenAddress: String(row.token_address), name: row.name ?? null, symbol: row.symbol ?? null,
          logoUri: row.logo_uri ?? null, platform: String(row.platform),
        })),
        pools: poolHits,
      };
    },
  };
}
