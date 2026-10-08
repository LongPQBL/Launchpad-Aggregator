export type QuoteState = 'idle' | 'loading' | 'ready' | 'unavailable';
export type TradeButtonKind =
  | 'connect' | 'switch-network' | 'enter-amount' | 'loading-quote' | 'loading-balance'
  | 'insufficient' | 'approve' | 'quote-unavailable' | 'swap';

export interface TradeButtonInput {
  isConnected: boolean;
  isWrongChain: boolean;
  amountIn: bigint;
  quoteState: QuoteState;
  balanceKnown: boolean;
  hasInsufficientBalance: boolean;
  needsApproval: boolean;
  canBatchApprove: boolean;
  tokenInSymbol: string | undefined;
}

export interface TradeButtonState {
  kind: TradeButtonKind;
  label: string;
  disabled: boolean;
}

// The one place that decides what the trade button says. First match wins; see the plan's ladder.
export function resolveTradeButton(input: TradeButtonInput): TradeButtonState {
  const { isConnected, isWrongChain, amountIn, quoteState, balanceKnown, hasInsufficientBalance, needsApproval, canBatchApprove, tokenInSymbol } = input;
  if (!isConnected) return { kind: 'connect', label: 'Connect', disabled: false };
  if (isWrongChain) return { kind: 'switch-network', label: 'Switch network', disabled: true };
  if (amountIn === 0n) {
    if (quoteState === 'loading') return { kind: 'loading-quote', label: 'Getting quote…', disabled: true };
    if (quoteState === 'unavailable') return { kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true };
    return { kind: 'enter-amount', label: 'Enter an amount', disabled: true };
  }
  if (!balanceKnown) return { kind: 'loading-balance', label: 'Checking balance…', disabled: true };
  if (hasInsufficientBalance) return { kind: 'insufficient', label: `Not enough ${tokenInSymbol ?? 'token'}`, disabled: true };
  if (needsApproval && !canBatchApprove) return { kind: 'approve', label: 'Approve', disabled: false };
  if (quoteState === 'loading' || quoteState === 'idle') return { kind: 'loading-quote', label: 'Getting quote…', disabled: true };
  if (quoteState === 'unavailable') return { kind: 'quote-unavailable', label: 'Quote unavailable', disabled: true };
  return { kind: 'swap', label: 'Swap', disabled: false };
}

export function deriveQuoteState(input: {
  source: 'sell' | 'buy';
  reverseStatus: 'idle' | 'loading' | 'ok' | 'unavailable';
  amountIn: bigint;
  outputAmount: bigint | null;
  errorMessage: string | null;
}): QuoteState {
  const { source, reverseStatus, amountIn, outputAmount, errorMessage } = input;
  if (source === 'buy' && reverseStatus === 'loading') return 'loading';
  if (source === 'buy' && reverseStatus === 'unavailable') return 'unavailable';
  if (amountIn === 0n) return 'idle';
  if (outputAmount !== null) return 'ready';
  if (errorMessage !== null) return 'unavailable';
  return 'loading';
}
