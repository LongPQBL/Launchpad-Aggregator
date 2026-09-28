export interface CurveReserves { quote: bigint; token: bigint }
export interface CurveEventAmounts { side: 'buy' | 'sell'; quoteAmountRaw: bigint; tokenAmountRaw: bigint; feeRaw: bigint; taxRaw: bigint }
export interface CurveBuybackAmounts { quoteSpentRaw: bigint; tokensLockedRaw: bigint }

export function replayCurveEvent(reserves: CurveReserves, event: CurveEventAmounts): CurveReserves {
  if (reserves.quote <= 0n || reserves.token <= 0n || event.quoteAmountRaw <= 0n || event.tokenAmountRaw <= 0n
    || event.feeRaw < 0n || event.taxRaw < 0n) throw new Error('Invalid curve reserves or trade amounts');
  if (event.side === 'buy') {
    const netQuote = event.quoteAmountRaw - event.feeRaw - event.taxRaw;
    if (netQuote <= 0n || event.tokenAmountRaw >= reserves.token) throw new Error('Invalid curve buy reserve movement');
    return { quote: reserves.quote + netQuote, token: reserves.token - event.tokenAmountRaw };
  }
  const grossQuote = event.quoteAmountRaw + event.feeRaw + event.taxRaw;
  if (grossQuote >= reserves.quote) throw new Error('Invalid curve sell reserve movement');
  return { quote: reserves.quote - grossQuote, token: reserves.token + event.tokenAmountRaw };
}

export function rewindCurveEvent(reserves: CurveReserves, event: CurveEventAmounts): CurveReserves {
  if (reserves.quote <= 0n || reserves.token <= 0n || event.quoteAmountRaw <= 0n || event.tokenAmountRaw <= 0n
    || event.feeRaw < 0n || event.taxRaw < 0n) throw new Error('Invalid curve reserves or trade amounts');
  if (event.side === 'buy') {
    const netQuote = event.quoteAmountRaw - event.feeRaw - event.taxRaw;
    if (netQuote <= 0n || netQuote >= reserves.quote) throw new Error('Invalid curve buy reserve movement');
    return { quote: reserves.quote - netQuote, token: reserves.token + event.tokenAmountRaw };
  }
  const grossQuote = event.quoteAmountRaw + event.feeRaw + event.taxRaw;
  if (event.tokenAmountRaw >= reserves.token) throw new Error('Invalid curve sell reserve movement');
  return { quote: reserves.quote + grossQuote, token: reserves.token - event.tokenAmountRaw };
}

export function replayCurveBuyback(reserves: CurveReserves, event: CurveBuybackAmounts): CurveReserves {
  if (reserves.quote <= 0n || reserves.token <= 0n || event.quoteSpentRaw <= 0n
    || event.tokensLockedRaw <= 0n || event.tokensLockedRaw >= reserves.token) throw new Error('Invalid curve buyback');
  return { quote: reserves.quote + event.quoteSpentRaw, token: reserves.token - event.tokensLockedRaw };
}

export function rewindCurveBuyback(reserves: CurveReserves, event: CurveBuybackAmounts): CurveReserves {
  if (reserves.quote <= 0n || reserves.token <= 0n || event.quoteSpentRaw <= 0n
    || event.tokensLockedRaw <= 0n || event.quoteSpentRaw >= reserves.quote) throw new Error('Invalid curve buyback');
  return { quote: reserves.quote - event.quoteSpentRaw, token: reserves.token + event.tokensLockedRaw };
}
