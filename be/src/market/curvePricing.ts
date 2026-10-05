import type { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { launchCurveReserves } from '../db/schema.js';
import { replayCurveEvent, replayCurveBuyback, type CurveReserves } from '../launchpads/pons/v2/curve.js';
import { readTotalSupply } from './tokenStats.js';
import type { UsdPriceClient } from './usdPricing.js';

export interface LaunchKey { chainId: number; tokenAddress: string }

// A reorg-repaired launch's checkpoint is simply deleted, never patched in place: the next worker
// tick re-derives it from totalSupply() and a full replay of that launch's (now-corrected) trades —
// safe because it's idempotent, not because it's cheap to skip.
export async function invalidateCurveReserve(tx: DbOrTx, keys: readonly LaunchKey[]): Promise<void> {
  for (const key of keys) {
    await tx.delete(launchCurveReserves).where(and(eq(launchCurveReserves.chainId, key.chainId), eq(launchCurveReserves.tokenAddress, key.tokenAddress)));
  }
}

export interface CurvePricingTables {
  rawCurveTradeTable: string;
  rawCurveBuybackTable: string;
}

const DEFAULT_TABLES: CurvePricingTables = {
  rawCurveTradeTable: 'envio."RawCurveTrade"',
  rawCurveBuybackTable: 'envio."RawCurveBuyback"',
};

interface DueLaunch {
  chainId: number; tokenAddress: string; tokenDecimals: number; quoteAssetDecimals: number;
}

interface DueTrade {
  txHash: string; logIndex: number; blockNumber: bigint; sourceEvent: string;
  side: string; tokenAmountRaw: bigint; quoteAmountRaw: bigint;
}

// Finds launches with a priced-behind (or never-started) curve, not just never-started: a launch
// already caught up has no row returned here (its checkpoint's (block, logIndex) is >= its latest
// curve trade's), so a steady-state tick costs one cheap query per batch, not a full rescan.
async function findDueLaunches(pool: Pool, limit: number): Promise<DueLaunch[]> {
  const result = await pool.query(`
    SELECT DISTINCT l.chain_id, l.token_address, l.token_decimals, l.quote_asset_decimals
    FROM launches l
    JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.kind = 'curve' AND v.official = true
    JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
      AND t.source_event IN ('CurveBuy', 'CurveSell', 'BuybackLocked')
    LEFT JOIN launch_curve_reserves r ON r.chain_id = l.chain_id AND r.token_address = l.token_address
    WHERE l.token_decimals IS NOT NULL AND l.quote_asset_decimals IS NOT NULL
      AND (r.chain_id IS NULL OR (t.block_number, t.log_index) > (r.last_block_number, r.last_log_index))
    LIMIT $1`, [limit]);
  return result.rows.map((row: Record<string, unknown>) => ({
    chainId: Number(row.chain_id), tokenAddress: String(row.token_address),
    tokenDecimals: Number(row.token_decimals), quoteAssetDecimals: Number(row.quote_asset_decimals),
  }));
}

async function readCheckpoint(pool: Pool, chainId: number, tokenAddress: string):
Promise<{ reserves: CurveReserves; lastBlockNumber: bigint; lastLogIndex: number } | null> {
  const result = await pool.query(
    `SELECT quote_reserve_raw, token_reserve_raw, last_block_number, last_log_index FROM launch_curve_reserves
     WHERE chain_id = $1 AND token_address = $2`, [chainId, tokenAddress]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    reserves: { quote: BigInt(String(row.quote_reserve_raw)), token: BigInt(String(row.token_reserve_raw)) },
    lastBlockNumber: BigInt(String(row.last_block_number)), lastLogIndex: Number(row.last_log_index),
  };
}

async function readDueTrades(pool: Pool, chainId: number, tokenAddress: string,
  afterBlock: bigint, afterLogIndex: number): Promise<DueTrade[]> {
  const result = await pool.query(`
    SELECT t.tx_hash, t.log_index, t.block_number, t.source_event, t.side, t.token_amount_raw, t.quote_amount_raw
    FROM trades t JOIN venues v ON v.id = t.venue_id
    WHERE t.chain_id = $1 AND t.token_address = $2 AND v.kind = 'curve' AND v.official = true
      AND t.source_event IN ('CurveBuy', 'CurveSell', 'BuybackLocked')
      AND (t.block_number, t.log_index) > ($3, $4)
    ORDER BY t.block_number ASC, t.log_index ASC`, [chainId, tokenAddress, afterBlock.toString(), afterLogIndex]);
  return result.rows.map((row: Record<string, unknown>) => ({
    txHash: String(row.tx_hash), logIndex: Number(row.log_index), blockNumber: BigInt(String(row.block_number)),
    sourceEvent: String(row.source_event), side: String(row.side),
    tokenAmountRaw: BigInt(String(row.token_amount_raw)), quoteAmountRaw: BigInt(String(row.quote_amount_raw)),
  }));
}

async function readFeeTax(envioPool: Pool, table: string, chainId: number, txHash: string, logIndex: number):
Promise<{ feeRaw: bigint; taxRaw: bigint } | null> {
  const result = await envioPool.query(
    `SELECT "feeRaw", "taxRaw" FROM ${table} WHERE "chainId" = $1 AND "txHash" = $2 AND "logIndex" = $3`,
    [chainId, txHash, logIndex]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return { feeRaw: BigInt(String(row.feeRaw)), taxRaw: BigInt(String(row.taxRaw)) };
}

function priceFromReserves(reserves: CurveReserves, tokenDecimals: number, quoteAssetDecimals: number):
{ priceNumeratorRaw: string; priceDenominatorRaw: string } {
  return {
    priceNumeratorRaw: (reserves.quote * 10n ** BigInt(tokenDecimals)).toString(),
    priceDenominatorRaw: (reserves.token * 10n ** BigInt(quoteAssetDecimals)).toString(),
  };
}

// Replays a launch's curve trades from their own event amounts (be/src/launchpads/pons/v2/curve.ts)
// to price them — no per-trade RPC call. The only RPC call is totalSupply() when a launch's
// checkpoint doesn't exist yet, because every V2 curve starts with the full supply and 0 quote
// (verified live against an active and a graduated launch; see the 2026-10-06 plan).
export async function applyCurvePricingOnce(pool: Pool, envioPool: Pool, client: UsdPriceClient, limit: number,
  now: Date, tables: CurvePricingTables = DEFAULT_TABLES): Promise<{ processed: number; pricedTrades: number }> {
  const due = await findDueLaunches(pool, limit);
  let pricedTrades = 0;
  for (const launch of due) {
    try {
      const checkpoint = await readCheckpoint(pool, launch.chainId, launch.tokenAddress);
      let reserves: CurveReserves;
      let afterBlock: bigint;
      let afterLogIndex: number;
      if (checkpoint) {
        reserves = checkpoint.reserves; afterBlock = checkpoint.lastBlockNumber; afterLogIndex = checkpoint.lastLogIndex;
      } else {
        const totalSupply = await readTotalSupply(client, launch.tokenAddress as `0x${string}`);
        if (totalSupply === null) continue;
        reserves = { quote: 0n, token: totalSupply }; afterBlock = 0n; afterLogIndex = -1;
      }
      const dueTrades = await readDueTrades(pool, launch.chainId, launch.tokenAddress, afterBlock, afterLogIndex);
      if (dueTrades.length === 0) continue;
      const updates: { txHash: string; logIndex: number; priceNumeratorRaw: string; priceDenominatorRaw: string }[] = [];
      for (const trade of dueTrades) {
        if (trade.sourceEvent === 'BuybackLocked') {
          reserves = replayCurveBuyback(reserves, { quoteSpentRaw: trade.quoteAmountRaw, tokensLockedRaw: trade.tokenAmountRaw });
        } else {
          const feeTax = await readFeeTax(envioPool, tables.rawCurveTradeTable, launch.chainId, trade.txHash, trade.logIndex);
          if (!feeTax) throw new Error(`Missing raw curve trade row for ${trade.txHash}:${trade.logIndex}`);
          reserves = replayCurveEvent(reserves, { side: trade.side as 'buy' | 'sell',
            quoteAmountRaw: trade.quoteAmountRaw, tokenAmountRaw: trade.tokenAmountRaw, ...feeTax });
        }
        updates.push({ txHash: trade.txHash, logIndex: trade.logIndex,
          ...priceFromReserves(reserves, launch.tokenDecimals, launch.quoteAssetDecimals) });
      }
      const last = dueTrades[dueTrades.length - 1]!;
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        for (const update of updates) {
          await dbClient.query(
            `UPDATE trades SET price_numerator_raw = $1, price_denominator_raw = $2
             WHERE chain_id = $3 AND tx_hash = $4 AND log_index = $5`,
            [update.priceNumeratorRaw, update.priceDenominatorRaw, launch.chainId, update.txHash, update.logIndex]);
        }
        await dbClient.query(
          `INSERT INTO launch_curve_reserves (chain_id, token_address, quote_reserve_raw, token_reserve_raw, last_block_number, last_log_index, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (chain_id, token_address) DO UPDATE SET
             quote_reserve_raw = EXCLUDED.quote_reserve_raw, token_reserve_raw = EXCLUDED.token_reserve_raw,
             last_block_number = EXCLUDED.last_block_number, last_log_index = EXCLUDED.last_log_index, updated_at = EXCLUDED.updated_at`,
          [launch.chainId, launch.tokenAddress, reserves.quote.toString(), reserves.token.toString(),
            last.blockNumber.toString(), last.logIndex, now]);
        await dbClient.query('COMMIT');
      } catch (error) {
        await dbClient.query('ROLLBACK');
        throw error;
      } finally {
        dbClient.release();
      }
      pricedTrades += updates.length;
    } catch {
      // One launch's bad data (or a transient RPC failure for its first totalSupply read) must not
      // block the rest of the batch; it is simply retried next tick.
      continue;
    }
  }
  return { processed: due.length, pricedTrades };
}
