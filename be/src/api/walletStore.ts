import type { Pool } from 'pg';
import { formatUnits } from 'viem';
import { readLaunchStats } from './launchStatsStore.js';

export interface WalletPosition {
  token: { chainId: number; tokenAddress: string; name: string | null; symbol: string | null; logoUri: string | null; decimals: number | null };
  tradeCount: number; buyCount: number; sellCount: number;
  firstTradeAt: number; lastTradeAt: number;
  quoteAsset: { address: string; symbol: string | null };
  /** Total quote paid in this wallet's buys / received in its sells, in whole quote-asset units (null when the quote asset's decimals are unknown). */
  quoteSpent: string | null;
  quoteReceived: string | null;
  priceUsd: string | null;
}
export interface WalletPositions { items: WalletPosition[] }
export interface WalletStore { listPositions(chainId: number | undefined, address: string, limit: number): Promise<WalletPositions> }

/**
 * The launches a wallet has traded on the indexed official venues, newest activity first.
 * "Trader" is the address recorded on the trade event, so a swap routed through a contract is attributed to
 * whoever the venue reported, and plain transfers are invisible — current balances are read on-chain by the client.
 */
export function createWalletStore(pool: Pool): WalletStore {
  return {
    async listPositions(chainId, address, limit) {
      const result = await pool.query(`
        SELECT t.chain_id, t.token_address, count(*)::int AS trade_count,
          count(*) FILTER (WHERE t.side = 'buy')::int AS buy_count, count(*) FILTER (WHERE t.side = 'sell')::int AS sell_count,
          min(t.timestamp) AS first_trade_at, max(t.timestamp) AS last_trade_at,
          COALESCE(sum(t.quote_amount_raw) FILTER (WHERE t.side = 'buy'), 0)::text AS quote_spent_raw,
          COALESCE(sum(t.quote_amount_raw) FILTER (WHERE t.side = 'sell'), 0)::text AS quote_received_raw
        FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.trader_address = $1 AND v.official = true AND ($2::integer IS NULL OR t.chain_id = $2)
        GROUP BY t.chain_id, t.token_address
        ORDER BY max(t.timestamp) DESC, t.token_address
        LIMIT $3`, [address.toLowerCase(), chainId ?? null, limit]);
      if (result.rows.length === 0) return { items: [] };

      const keys = result.rows.map((row) => ({ chainId: Number(row.chain_id), tokenAddress: String(row.token_address) }));
      const launches = await pool.query(`SELECT l.chain_id, l.token_address, l.name, l.symbol, l.logo_uri, l.token_decimals,
          l.quote_asset_address, l.quote_asset_symbol, l.quote_asset_decimals
        FROM launches l JOIN unnest($1::int[], $2::text[]) AS k(chain_id, token_address)
          ON k.chain_id = l.chain_id AND k.token_address = l.token_address`,
      [keys.map((key) => key.chainId), keys.map((key) => key.tokenAddress)]);
      const launchByKey = new Map(launches.rows.map((row) => [`${row.chain_id}:${row.token_address}`, row]));
      const stats = await readLaunchStats(pool, keys);

      const items: WalletPosition[] = [];
      for (const row of result.rows) {
        const key = `${row.chain_id}:${row.token_address}`;
        const launch = launchByKey.get(key);
        if (!launch) continue;
        const quoteDecimals = launch.quote_asset_decimals === null ? null : Number(launch.quote_asset_decimals);
        items.push({
          token: { chainId: Number(row.chain_id), tokenAddress: String(row.token_address), name: launch.name ?? null,
            symbol: launch.symbol ?? null, logoUri: launch.logo_uri ?? null,
            decimals: launch.token_decimals === null ? null : Number(launch.token_decimals) },
          tradeCount: Number(row.trade_count), buyCount: Number(row.buy_count), sellCount: Number(row.sell_count),
          firstTradeAt: Number(row.first_trade_at), lastTradeAt: Number(row.last_trade_at),
          quoteAsset: { address: String(launch.quote_asset_address), symbol: launch.quote_asset_symbol ?? null },
          quoteSpent: quoteDecimals === null ? null : formatUnits(BigInt(String(row.quote_spent_raw)), quoteDecimals),
          quoteReceived: quoteDecimals === null ? null : formatUnits(BigInt(String(row.quote_received_raw)), quoteDecimals),
          priceUsd: stats.get(key)?.priceUsd ?? null,
        });
      }
      return { items };
    },
  };
}
