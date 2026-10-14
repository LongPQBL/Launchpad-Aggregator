import type { Pool } from 'pg';

export type LaneState = 'on' | 'off';
export interface GovernorOptions {
  /** Envio is "behind" at or above this many blocks (the chain makes ~8 a second). Default 40, about 5 s. */
  onLagBlocks?: number;
  /** Envio is "keeping up" at or below this many blocks. Default 16, about 2 s. */
  offLagBlocks?: number;
  /** Consecutive samples behind before the lane starts. Default 3 (30 s at one sample per 10 s). */
  onAfterSamples?: number;
  /** Consecutive samples keeping up before the lane stops. Default 30 (5 min), so a short quiet spell does not switch it off. */
  offAfterSamples?: number;
}

export interface Governor {
  state(): LaneState;
  /** Feeds one measurement of how far Envio's pipeline is behind the chain head (null: unknown). Returns the new state when it changed. */
  observe(lagBlocks: number | null): LaneState | null;
}

/**
 * Decides when the fast lane is worth running: when Envio's pipeline (chain -> Envio -> sync -> `trades`) trails the head by more than a few
 * seconds, the lane gains something; when Envio keeps up, it gains well under a second and is only extra moving parts. Switching on needs a
 * few consecutive "behind" samples and switching off many consecutive "keeping up" ones, so a blip does not make it flap. An unknown lag (the sync
 * never ran, or the head could not be read) counts as behind: nothing else is delivering trades then.
 */
export function createGovernor(options: GovernorOptions = {}): Governor {
  const onLag = options.onLagBlocks ?? 40;
  const offLag = options.offLagBlocks ?? 16;
  const onAfter = options.onAfterSamples ?? 3;
  const offAfter = options.offAfterSamples ?? 30;
  let state: LaneState = 'off';
  let behindStreak = 0;
  let keepingUpStreak = 0;
  return {
    state: () => state,
    observe(lagBlocks) {
      const behind = lagBlocks === null || lagBlocks >= onLag;
      const keepingUp = lagBlocks !== null && lagBlocks <= offLag;
      behindStreak = behind ? behindStreak + 1 : 0;
      keepingUpStreak = keepingUp ? keepingUpStreak + 1 : 0;
      if (state === 'off' && behindStreak >= onAfter) { state = 'on'; keepingUpStreak = 0; return 'on'; }
      if (state === 'on' && keepingUpStreak >= offAfter) { state = 'off'; behindStreak = 0; return 'off'; }
      return null;
    },
  };
}

const TRADE_STREAMS = ['v1-swap', 'v2-curve', 'v2-buyback', 'v4-swap'];

/**
 * How many blocks the trade streams of the Envio sync trail the chain head: the slowest stream's best lane (tail or history) against the head.
 * This is what a user would see without the lane. null when the sync has no position for one of the streams.
 */
export async function readEnvioLagBlocks(pool: Pool, chainId: number, headBlock: bigint): Promise<number | null> {
  const result = await pool.query(
    `SELECT min(best) AS applied, count(*) AS streams FROM (
       SELECT stream, max(processed_watermark) AS best FROM envio_sync_cursors
       WHERE chain_id = $1 AND stream = ANY($2::text[]) GROUP BY stream) s`,
    [chainId, TRADE_STREAMS]);
  const row = result.rows[0] as { applied: string | null; streams: string } | undefined;
  if (!row || row.applied === null || Number(row.streams) < TRADE_STREAMS.length) return null;
  const lag = headBlock - BigInt(row.applied);
  return lag < 0n ? 0 : Number(lag);
}
