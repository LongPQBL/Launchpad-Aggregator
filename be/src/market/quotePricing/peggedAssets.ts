import type { Pool } from 'pg';
import { resolveVerifiedFeed, upsertQuoteFeed } from './feedRegistry.js';
import { upsertPriceRounds, type PriceRound } from './priceRounds.js';

// A USD stablecoin with no oracle feed is priced as exactly $1, the way Uniswap treats its primary stablecoin (USDC is $1 by definition and
// every other token is priced through pools against it). Its value rests on the issuer's redemption peg, not on a market read, so a depeg is
// NOT seen; that is why the asset is listed here by hand (address, never symbol) and its feed is marked `discovery_source = 'peg'`.
export const PEG_DISCOVERY_SOURCE = 'peg';

export interface PeggedAsset { chainId: number; address: string; symbol: string }

export const PEGGED_USD_ASSETS: readonly PeggedAsset[] = [
  // Global Dollar (Paxos), 1:1 redeemable for US dollars. Not in the Robinhood asset directory, so it has no Chainlink feed on this chain.
  { chainId: 4663, address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG' },
];

const HOUR_SECONDS = 3_600;
const ANSWER = 100_000_000n; // 1.00000000 with 8 decimals, like a Chainlink USD feed
const ANSWER_DECIMALS = 8;
export const PEG_BACKFILL_DAYS = 30;

/**
 * Keeps one synthetic round of $1.00 per hour for each pegged asset, so every consumer of oracle rounds (the SQL volume and candle rollups,
 * trade valuation, TVL) prices it without a special case: a trade always finds a round at most two hours old. A round sits at the lowest
 * block of any trade at or after its hour, so it never precedes its own timestamp. Returns the number of rounds written.
 */
export async function ensurePeggedRounds(pool: Pool, chainId: number, now: Date,
  options: { backfillDays?: number; assets?: readonly PeggedAsset[] } = {}): Promise<number> {
  let written = 0;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const lastHour = Math.floor(nowSeconds / HOUR_SECONDS) * HOUR_SECONDS;
  for (const asset of (options.assets ?? PEGGED_USD_ASSETS).filter((candidate) => candidate.chainId === chainId)) {
    const address = asset.address.toLowerCase();
    // A real oracle feed that appears later wins: never overwrite another source's mapping.
    const existing = await resolveVerifiedFeed(pool, chainId, address);
    if (existing && existing.discoverySource !== PEG_DISCOVERY_SOURCE) continue;
    if (!existing) {
      await upsertQuoteFeed(pool, { chainId, quoteAssetAddress: address as `0x${string}`, feedAddress: address as `0x${string}`, aggregatorAddress: null,
        discoverySource: PEG_DISCOVERY_SOURCE, verificationStatus: 'verified', now });
    }
    const latest = (await pool.query('SELECT max(updated_at)::bigint AS latest FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2', [chainId, address])).rows[0]?.latest;
    const firstHour = latest === null || latest === undefined
      ? Math.floor((nowSeconds - (options.backfillDays ?? PEG_BACKFILL_DAYS) * 86_400) / HOUR_SECONDS) * HOUR_SECONDS
      : Number(latest) + HOUR_SECONDS;
    if (firstHour > lastHour) continue;
    const head = (await pool.query(`SELECT GREATEST(
      (SELECT head_block FROM envio_chain_progress WHERE chain_id = $1),
      (SELECT max(block_number) FROM trades WHERE chain_id = $1),
      (SELECT max(block_number) FROM pool_trades WHERE chain_id = $1)) AS head`, [chainId])).rows[0]?.head;
    if (head === null || head === undefined) continue; // nothing is indexed yet, so there is no block to place a round at
    // The lowest block of any trade in each hour, from the start hour on.
    const lowest = new Map<number, bigint>();
    for (const table of ['trades', 'pool_trades']) {
      const rows = (await pool.query(`SELECT (timestamp / ${HOUR_SECONDS}) * ${HOUR_SECONDS} AS hour, min(block_number) AS block FROM ${table}
        WHERE chain_id = $1 AND timestamp >= $2 GROUP BY 1`, [chainId, firstHour])).rows as { hour: string | number; block: string | number }[];
      for (const row of rows) {
        const hour = Number(row.hour);
        const block = BigInt(String(row.block));
        const current = lowest.get(hour);
        if (current === undefined || block < current) lowest.set(hour, block);
      }
    }
    // Walking back from the newest hour, `running` is the lowest block of any trade at or after that hour.
    const rounds: PriceRound[] = [];
    let running = BigInt(String(head));
    for (let hour = lastHour; hour >= firstHour; hour -= HOUR_SECONDS) {
      const here = lowest.get(hour);
      if (here !== undefined && here < running) running = here;
      rounds.push({ roundId: BigInt(hour / HOUR_SECONDS), answerRaw: ANSWER, decimals: ANSWER_DECIMALS, startedAt: hour, updatedAt: hour, blockNumber: running, logIndex: 0 });
    }
    written += await upsertPriceRounds(pool, chainId, address, rounds.reverse());
  }
  return written;
}
