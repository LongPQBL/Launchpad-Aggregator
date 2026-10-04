import type { Pool } from 'pg';

export interface PriceRound {
  roundId: bigint; answerRaw: bigint; decimals: number; startedAt: number; updatedAt: number;
  blockNumber: bigint; logIndex: number;
}

export async function upsertPriceRounds(pool: Pool, chainId: number, feedAddress: string, rounds: readonly PriceRound[]): Promise<number> {
  if (rounds.length === 0) return 0;
  let inserted = 0;
  for (const round of rounds) {
    const result = await pool.query(
      `INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chain_id, feed_address, round_id) DO NOTHING`,
      [chainId, feedAddress.toLowerCase(), round.roundId.toString(), round.answerRaw.toString(), round.decimals,
        round.startedAt, round.updatedAt, round.blockNumber.toString(), round.logIndex],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
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
