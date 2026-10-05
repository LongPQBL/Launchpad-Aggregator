import { describe, expect, it } from 'vitest';
import { replayCurveEvent, rewindCurveEvent, replayCurveBuyback, rewindCurveBuyback } from './curve.js';

describe('replayCurveEvent', () => {
  it('replays the very first buy from a freshly launched curve, whose quote reserve starts at 0', () => {
    const reserves = replayCurveEvent({ quote: 0n, token: 1000n },
      { side: 'buy', quoteAmountRaw: 100n, tokenAmountRaw: 90n, feeRaw: 1n, taxRaw: 1n });
    expect(reserves).toEqual({ quote: 98n, token: 910n });
  });

  it('still rejects a sell against a curve with no quote in it yet', () => {
    expect(() => replayCurveEvent({ quote: 0n, token: 1000n },
      { side: 'sell', quoteAmountRaw: 40n, tokenAmountRaw: 50n, feeRaw: 2n, taxRaw: 1n })).toThrow();
  });

  it('replays a sell once there is quote in the curve', () => {
    const reserves = replayCurveEvent({ quote: 98n, token: 910n },
      { side: 'sell', quoteAmountRaw: 40n, tokenAmountRaw: 50n, feeRaw: 2n, taxRaw: 1n });
    expect(reserves).toEqual({ quote: 55n, token: 960n });
  });
});

describe('rewindCurveEvent', () => {
  it('undoes a buy back to a curve with no quote in it', () => {
    const reserves = rewindCurveEvent({ quote: 98n, token: 910n },
      { side: 'buy', quoteAmountRaw: 100n, tokenAmountRaw: 90n, feeRaw: 1n, taxRaw: 1n });
    expect(reserves).toEqual({ quote: 0n, token: 1000n });
  });
});

describe('replayCurveBuyback', () => {
  it('replays a buyback as the very first event on a freshly launched curve', () => {
    const reserves = replayCurveBuyback({ quote: 0n, token: 1000n }, { quoteSpentRaw: 10n, tokensLockedRaw: 5n });
    expect(reserves).toEqual({ quote: 10n, token: 995n });
  });
});

describe('rewindCurveBuyback', () => {
  it('undoes a buyback back to a curve with no quote in it', () => {
    const reserves = rewindCurveBuyback({ quote: 10n, token: 995n }, { quoteSpentRaw: 10n, tokensLockedRaw: 5n });
    expect(reserves).toEqual({ quote: 0n, token: 1000n });
  });
});
