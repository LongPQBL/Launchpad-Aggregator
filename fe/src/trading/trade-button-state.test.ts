import { describe, expect, it } from 'vitest';
import { deriveQuoteState, resolveTradeButton, type TradeButtonInput } from './trade-button-state';

const ready: TradeButtonInput = {
  isConnected: true, isWrongChain: false, amountIn: 10n ** 18n, quoteState: 'ready',
  balanceKnown: true, hasInsufficientBalance: false, needsApproval: false, canBatchApprove: false, tokenInSymbol: 'ETH',
};
const resolve = (over: Partial<TradeButtonInput>) => resolveTradeButton({ ...ready, ...over });

describe('resolveTradeButton', () => {
  it('connect comes first, even with no amount and a wrong chain', () => {
    expect(resolve({ isConnected: false, amountIn: 0n, isWrongChain: true })).toEqual({ kind: 'connect', label: 'Connect', disabled: false });
  });
  it('wrong chain', () => {
    expect(resolve({ isWrongChain: true })).toEqual({ kind: 'switch-network', label: 'Switch network', disabled: true });
  });
  it('no amount', () => {
    expect(resolve({ amountIn: 0n, quoteState: 'idle' })).toEqual({ kind: 'enter-amount', label: 'Enter an amount', disabled: true });
  });
  it('a Buy-typed amount still being converted shows Getting quote…', () => {
    expect(resolve({ amountIn: 0n, quoteState: 'loading' })).toEqual({ kind: 'loading-quote', label: 'Getting quote…', disabled: true });
  });
  it('a Buy-typed amount with no answer shows Quote unavailable', () => {
    expect(resolve({ amountIn: 0n, quoteState: 'unavailable' })).toEqual({ kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true });
  });
  it('balance still loading never claims "Not enough"', () => {
    expect(resolve({ balanceKnown: false, hasInsufficientBalance: true })).toEqual({ kind: 'loading-balance', label: 'Checking balance…', disabled: true });
  });
  it('insufficient balance names the token being entered', () => {
    expect(resolve({ hasInsufficientBalance: true })).toEqual({ kind: 'insufficient', label: 'Not enough ETH', disabled: true });
    expect(resolve({ hasInsufficientBalance: true, tokenInSymbol: undefined }).label).toBe('Not enough token');
  });
  it('insufficient balance wins over a quote that is still loading (the amount is already known)', () => {
    expect(resolve({ hasInsufficientBalance: true, quoteState: 'loading' }).kind).toBe('insufficient');
  });
  it('approval needed (no batching) shows Approve even before the quote is available', () => {
    expect(resolve({ needsApproval: true, quoteState: 'unavailable' })).toEqual({ kind: 'approve', label: 'Approve', disabled: false });
  });
  it('approval is skipped when the wallet batches it', () => {
    expect(resolve({ needsApproval: true, canBatchApprove: true }).kind).toBe('swap');
  });
  it('quote loading / idle with an amount', () => {
    expect(resolve({ quoteState: 'loading' }).label).toBe('Getting quote…');
    expect(resolve({ quoteState: 'idle' }).label).toBe('Getting quote…');
  });
  it('quote unavailable', () => {
    expect(resolve({ quoteState: 'unavailable' })).toEqual({ kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true });
  });
  it('ready to swap', () => {
    expect(resolve({})).toEqual({ kind: 'swap', label: 'Swap', disabled: false });
  });
});

describe('deriveQuoteState', () => {
  const base = { source: 'sell' as const, reverseStatus: 'idle' as const, amountIn: 1n, outputAmount: null, errorMessage: null };
  it('buy-typed: follows the reverse quote', () => {
    expect(deriveQuoteState({ ...base, source: 'buy', reverseStatus: 'loading', amountIn: 0n })).toBe('loading');
    expect(deriveQuoteState({ ...base, source: 'buy', reverseStatus: 'unavailable', amountIn: 0n })).toBe('unavailable');
  });
  it('no amount → idle', () => {
    expect(deriveQuoteState({ ...base, amountIn: 0n })).toBe('idle');
  });
  it('forward quote: ready, unavailable on error, loading otherwise', () => {
    expect(deriveQuoteState({ ...base, outputAmount: 5n })).toBe('ready');
    expect(deriveQuoteState({ ...base, errorMessage: 'revert' })).toBe('unavailable');
    expect(deriveQuoteState(base)).toBe('loading');
  });
});
