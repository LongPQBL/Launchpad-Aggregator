import { describe, expect, it, vi } from 'vitest';
import { SOLVER_MAX_ROUNDS, SOLVER_WIDE_POINTS, solveInputForOutput, type QuoteFn } from './solve-input-for-output';

const never = new AbortController().signal;
const within = (x: bigint, trueMin: bigint) => x >= trueMin && x <= trueMin + trueMin / 10_000n + 1n;

const linear: QuoteFn = async (x) => x * 3n;
const convex: QuoteFn = async (x) => (x * x) / 10n ** 18n;
const capped = (capacity: bigint): QuoteFn => async (x) => (x > capacity ? null : x * 3n);
// reverts for dust (below a minimum trade size), like the real curve's zero-output revert
const dust = (min: bigint): QuoteFn => async (x) => (x < min ? null : x / 2n);

describe('solveInputForOutput', () => {
  it('solves a linear quote within 0.01%', async () => {
    const x = await solveInputForOutput(linear, 3n * 10n ** 18n);
    expect(x).not.toBeNull();
    expect(await linear(x!, never)).toBeGreaterThanOrEqual(3n * 10n ** 18n);
    expect(within(x!, 10n ** 18n)).toBe(true);
  });

  it('solves a convex (curve-like) quote', async () => {
    const x = await solveInputForOutput(convex, 4n * 10n ** 18n); // x^2/1e18 = 4e18 -> x = 2e18
    expect(await convex(x!, never)).toBeGreaterThanOrEqual(4n * 10n ** 18n);
    expect(within(x!, 2n * 10n ** 18n)).toBe(true);
  });

  it('solves a tiny target down to the exact raw unit', async () => {
    const x = await solveInputForOutput(linear, 1n);
    expect(x).toBe(1n);
  });

  it('does not mistake a dust revert for "too large"', async () => {
    const quote = dust(1_000_000_000n);
    const x = await solveInputForOutput(quote, 500_000_000n); // true minimum input = 1e9
    expect(x).not.toBeNull();
    expect(await quote(x!, never)).toBeGreaterThanOrEqual(500_000_000n);
    expect(within(x!, 1_000_000_000n)).toBe(true);
  });

  it('treats a null above capacity as TOO_LARGE and still solves a reachable target', async () => {
    const quote = capped(5n * 10n ** 18n);
    const x = await solveInputForOutput(quote, 12n * 10n ** 18n); // needs 4e18
    expect(x).not.toBeNull();
    expect(await quote(x!, never)).toBeGreaterThanOrEqual(12n * 10n ** 18n);
    expect(within(x!, 4n * 10n ** 18n)).toBe(true);
  });

  it('returns null when the target exceeds capacity', async () => {
    expect(await solveInputForOutput(capped(5n * 10n ** 18n), 18n * 10n ** 18n)).toBeNull();
  });

  it('gives up quickly (<= 2 wide rounds) when every probe fails', async () => {
    const fn = vi.fn<QuoteFn>(async () => null);
    expect(await solveInputForOutput(fn, 1000n)).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2 * SOLVER_WIDE_POINTS);
  });

  it('treats a throwing quote function as a failed probe', async () => {
    expect(await solveInputForOutput(async () => { throw new Error('rpc down'); }, 1000n)).toBeNull();
  });

  it('returns null for a zero or negative target without calling the quote function', async () => {
    const fn = vi.fn<QuoteFn>(async (x) => x);
    expect(await solveInputForOutput(fn, 0n)).toBeNull();
    expect(await solveInputForOutput(fn, -5n)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops after maxRounds', async () => {
    const fn = vi.fn<QuoteFn>(async () => 1n); // always just under the target
    expect(await solveInputForOutput(fn, 2n, { maxRounds: 3 })).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3 * SOLVER_WIDE_POINTS);
    expect(SOLVER_MAX_ROUNDS).toBe(12);
  });

  it('returns null when the signal aborts, after at most one round of calls', async () => {
    const controller = new AbortController();
    const fn = vi.fn<QuoteFn>(async (x) => { controller.abort(); return x * 3n; });
    expect(await solveInputForOutput(fn, 3n * 10n ** 18n, { signal: controller.signal })).toBeNull();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(SOLVER_WIDE_POINTS);
  });

  it('probes in parallel: a round has several quotes in flight at once, never more than the grid size', async () => {
    let inFlight = 0;
    let peak = 0;
    const quote: QuoteFn = async (x) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return x * 3n;
    };
    await solveInputForOutput(quote, 3n * 10n ** 18n);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SOLVER_WIDE_POINTS);
  });

  it('an accurate initialGuess solves in few calls', async () => {
    const fn = vi.fn<QuoteFn>(linear);
    const x = await solveInputForOutput(fn, 3n * 10n ** 18n, { initialGuess: 10n ** 18n });
    expect(within(x!, 10n ** 18n)).toBe(true);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(9 + 8 * 4); // guess round + <= 4 refine rounds
  });

  it('a badly wrong initialGuess (100x too small, e.g. a snipe-tax window) still solves', async () => {
    const x = await solveInputForOutput(linear, 3n * 10n ** 18n, { initialGuess: 10n ** 16n });
    expect(within(x!, 10n ** 18n)).toBe(true);
  });
});
