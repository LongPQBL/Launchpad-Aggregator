import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { invalidateForPriceChange } from '../launchVolume/oracleInvalidation.js';

export interface PriceRound {
  roundId: bigint; answerRaw: bigint; decimals: number; startedAt: number; updatedAt: number;
  blockNumber: bigint; logIndex: number;
}

export async function upsertPriceRounds(pool: Pool, chainId: number, feedAddress: string, rounds: readonly PriceRound[]): Promise<number> {
  if (rounds.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const feed = feedAddress.toLowerCase();
    let inserted = 0;
    let fromBlock: bigint | null = null;
    let toBlock: bigint | null = null;
    for (const round of rounds) {
      const result = await client.query(
        `INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (chain_id, feed_address, round_id) DO NOTHING`,
        [chainId, feed, round.roundId.toString(), round.answerRaw.toString(), round.decimals,
          round.startedAt, round.updatedAt, round.blockNumber.toString(), round.logIndex],
      );
      const added = result.rowCount ?? 0;
      inserted += added;
      if (added > 0) {
        if (fromBlock === null || round.blockNumber < fromBlock) fromBlock = round.blockNumber;
        if (toBlock === null || round.blockNumber > toBlock) toBlock = round.blockNumber;
      }
    }
    if (fromBlock !== null && toBlock !== null) {
      const mapped = await client.query('SELECT quote_asset_address FROM quote_usd_feeds WHERE chain_id = $1 AND feed_address = $2', [chainId, feed]);
      const executor = drizzle(client);
      for (const row of mapped.rows) {
        await invalidateForPriceChange(executor, { chainId, quoteAssetAddress: row.quote_asset_address, feedAddress: feed, fromBlock, toBlock });
      }
    }
    await client.query('COMMIT');
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findRoundAtOrBefore(pool: Pool, chainId: number, feedAddress: string, blockNumber: bigint, logIndex: number): Promise<PriceRound | null> {
  const result = await pool.query(
    `SELECT round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index FROM quote_usd_price_rounds
     WHERE chain_id = $1 AND feed_address = $2 AND (block_number, log_index) <= ($3, $4)
     ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    [chainId, feedAddress.toLowerCase(), blockNumber.toString(), logIndex],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    roundId: BigInt(String(row.round_id)), answerRaw: BigInt(String(row.answer_raw)), decimals: Number(row.decimals),
    startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
    blockNumber: BigInt(String(row.block_number)), logIndex: Number(row.log_index),
  };
}
