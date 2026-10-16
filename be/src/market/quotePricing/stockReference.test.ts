import { describe, expect, it, vi } from 'vitest';
import { barsToRounds, parseStockBars, type StockBar } from './stockReference.js';

const bar = (beginsAt: string, close: string): StockBar => ({ begins_at: beginsAt, close_price: close } as StockBar);

describe('parseStockBars', () => {
  it('keeps well-formed bars and drops the rest', () => {
    const bars = parseStockBars({ results: [{ historicals: [
      { begins_at: '2026-10-15T15:00:00Z', close_price: '208.570000' },
      { begins_at: 'nope', close_price: '1' },
      { begins_at: '2026-10-15T15:05:00Z', close_price: '0.000000' },
      { begins_at: '2026-10-15T15:10:00Z', close_price: null },
    ] }] });
    expect(bars).toEqual([{ begins_at: '2026-10-15T15:00:00Z', close_price: '208.570000' }]);
  });
  it('returns an empty list for an unexpected response', () => {
    expect(parseStockBars({})).toEqual([]);
    expect(parseStockBars(null)).toEqual([]);
  });
});

describe('barsToRounds', () => {
  const locate = vi.fn(async (seconds: number) => ({ block: BigInt(seconds), timestamp: seconds }));
  const end = Date.parse('2026-10-15T15:05:00Z') / 1000;

  it('turns a closed bar into a round priced at its close, positioned after every trade of the located block', async () => {
    const rounds = await barsToRounds([bar('2026-10-15T15:00:00Z', '208.570000')], 300, end + 10, 0, locate);
    expect(rounds).toEqual([{ roundId: BigInt(end), answerRaw: 20_857_000_000n, decimals: 8, startedAt: end - 300, updatedAt: end,
      blockNumber: BigInt(end), logIndex: 2_147_483_647 }]);
  });
  it('skips a bar that has not closed yet and a bar at or before the newest stored round', async () => {
    const rounds = await barsToRounds([bar('2026-10-15T15:00:00Z', '1'), bar('2026-10-15T15:05:00Z', '2')], 300, end + 10, end, locate);
    expect(rounds).toEqual([]);
    const open = await barsToRounds([bar('2026-10-15T15:00:00Z', '1')], 300, end - 1, 0, locate);
    expect(open).toEqual([]);
  });
  it('skips a bar whose block cannot be located instead of guessing a position', async () => {
    const rounds = await barsToRounds([bar('2026-10-15T15:00:00Z', '1')], 300, end + 10, 0, async () => null);
    expect(rounds).toEqual([]);
  });
});
