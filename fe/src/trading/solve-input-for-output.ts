// Exact-input quote: how much comes out for `amountIn` going in. `null` = the simulation reverted.
export type QuoteFn = (amountIn: bigint, signal: AbortSignal) => Promise<bigint | null>;

export const SOLVER_MAX_ROUNDS = 12;
export const SOLVER_WIDE_POINTS = 16;
export const SOLVER_REFINE_POINTS = 8;
const WIDE_FACTOR = 16n;
const MAX_INPUT = 1n << 128n; // far above any real token amount
const DEFAULT_START = 1_000_000n;
const GUESS_MULTIPLIERS_BPS = [2500n, 5000n, 9000n, 9900n, 10000n, 10100n, 11000n, 20000n, 40000n];

export interface SolveOptions {
  signal?: AbortSignal;
  maxRounds?: number;
  initialGuess?: bigint;
}

function wideGrid(start: bigint): bigint[] {
  const points: bigint[] = [];
  let x = start;
  for (let i = 0; i < SOLVER_WIDE_POINTS; i += 1) { points.push(x); x *= WIDE_FACTOR; }
  return points;
}

// Inverts a monotonic exact-input quote: finds (approximately) the smallest X with
// quoteFn(X) >= targetOut, so a swap executed as exact-input with X yields at least targetOut
// before slippage. Execution never changes — this only derives X for the Sell card when the user
// typed in the Buy card. Returns null (never a guess) when no X is found.
export async function solveInputForOutput(
  quoteFn: QuoteFn,
  targetOut: bigint,
  options: SolveOptions = {},
): Promise<bigint | null> {
  if (targetOut <= 0n) return null;
  const maxRounds = options.maxRounds ?? SOLVER_MAX_ROUNDS;
  const signal = options.signal ?? new AbortController().signal;

  let lo = 0n; // largest input known too small (SMALL or DUST)
  let best: bigint | null = null; // smallest input known ENOUGH
  let tooLarge: bigint | null = null; // smallest input that reverted although a smaller one succeeded
  let lowestNonNull: bigint | null = null;
  let allNullRounds = 0;

  let points: bigint[] = options.initialGuess && options.initialGuess > 0n
    ? GUESS_MULTIPLIERS_BPS.map((m) => (options.initialGuess as bigint * m) / 10_000n)
    : wideGrid(DEFAULT_START);

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal.aborted) return null;
    const unique = [...new Set(points)].filter((p) => p > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (unique.length === 0) return null;
    const results = await Promise.all(unique.map(async (x) => {
      try { return await quoteFn(x, signal); } catch { return null; }
    }));
    if (signal.aborted) return null;

    // Classify ascending: a null is TOO_LARGE only if a smaller input is known to succeed.
    for (let i = 0; i < unique.length; i += 1) {
      const x = unique[i];
      const q = results[i];
      if (q === null) {
        if (lowestNonNull !== null && lowestNonNull < x) {
          if (tooLarge === null || x < tooLarge) tooLarge = x;
        } else if (x > lo) {
          lo = x; // DUST: too small
        }
        continue;
      }
      if (lowestNonNull === null || x < lowestNonNull) lowestNonNull = x;
      if (q >= targetOut) {
        if (best === null || x < best) best = x;
      } else if (x > lo) {
        lo = x;
      }
    }

    if (lowestNonNull === null) {
      allNullRounds += 1;
      if (allNullRounds >= 2) return null;
    }

    const candidates = [best, tooLarge].filter((v): v is bigint => v !== null);
    const hi = candidates.length === 0 ? null : candidates.reduce((a, b) => (a < b ? a : b));

    if (hi === null) {
      const next = lo === 0n ? DEFAULT_START : lo * WIDE_FACTOR;
      if (next > MAX_INPUT) return null;
      points = wideGrid(next);
      continue;
    }

    const width = hi - lo;
    const tolerance = lo / 10_000n > 1n ? lo / 10_000n : 1n;
    if (width <= tolerance) return best;

    const divisor = BigInt(SOLVER_REFINE_POINTS + 1);
    points = Array.from({ length: SOLVER_REFINE_POINTS }, (_, j) => lo + (width * BigInt(j + 1)) / divisor);
  }
  return null;
}
