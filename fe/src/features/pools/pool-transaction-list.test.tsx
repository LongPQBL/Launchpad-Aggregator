import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PoolTrade } from '@/api/client';
import { PoolTransactionList } from './pool-transaction-list';

function trade(overrides: Partial<PoolTrade> = {}): PoolTrade {
  return {
    txHash: '0xabc', logIndex: 0, blockNumber: '100', timestamp: 1_700_000_000,
    traderAddress: '0x1234567890123456789012345678901234567890', side: 'buy',
    amount0Raw: '1000000000000000000', amount1Raw: '2000000000000000000',
    priceInQuote: '2', usdValue: '10', usdValueStatus: 'priced',
    ...overrides,
  };
}

describe('PoolTransactionList', () => {
  it('formats raw amounts using each side\'s own decimals, displayed side first', () => {
    render(<PoolTransactionList trades={[trade()]} displayedSymbol="SANTACOIN" otherSymbol="ETH"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase={null} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/^2 ETH$/)).toBeInTheDocument();
  });

  it('swaps which raw amount is "displayed" when the displayed token is currency1', () => {
    render(<PoolTransactionList trades={[trade()]} displayedSymbol="ETH" otherSymbol="SANTACOIN"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0={false} explorerBase={null} />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/^1 SANTACOIN$/)).toBeInTheDocument();
  });

  it('shows "—" instead of guessing an amount when decimals are unknown', () => {
    render(<PoolTransactionList trades={[trade()]} displayedSymbol="SANTACOIN" otherSymbol="ETH"
      displayedDecimals={null} otherDecimals={18} displayedIsCurrency0 explorerBase={null} />);
    expect(screen.getAllByText('—')).not.toHaveLength(0);
  });

  it('keeps "Buy" meaning the displayed token was acquired when currency0 is displayed', () => {
    render(<PoolTransactionList trades={[trade({ side: 'buy' })]} displayedSymbol="MOCK1" otherSymbol="ETH"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase={null} />);
    expect(screen.getByText(/^Buy /)).toBeInTheDocument();
  });

  it('flips Buy to Sell (and vice versa) when the flip link makes currency1 the displayed token', () => {
    render(<PoolTransactionList trades={[trade({ side: 'buy' })]} displayedSymbol="ETH" otherSymbol="MOCK1"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0={false} explorerBase={null} />);
    expect(screen.getByText(/^Sell /)).toBeInTheDocument();
    expect(screen.queryByText(/^Buy /)).not.toBeInTheDocument();
  });

  it('shows a loading state for a pending USD value', () => {
    render(<PoolTransactionList trades={[trade({ usdValueStatus: 'pending' })]} displayedSymbol="SANTACOIN" otherSymbol="ETH"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase={null} />);
    expect(screen.getByText(/calculating/i)).toBeInTheDocument();
  });

  it('links the wallet and tx hash to the explorer when one is known', () => {
    render(<PoolTransactionList trades={[trade()]} displayedSymbol="SANTACOIN" otherSymbol="ETH"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase="https://explorer.example" />);
    expect(screen.getByRole('link', { name: /0x1234/ })).toHaveAttribute('href', 'https://explorer.example/address/0x1234567890123456789012345678901234567890');
    expect(screen.getByRole('link', { name: /0xabc/ })).toHaveAttribute('href', 'https://explorer.example/tx/0xabc');
  });
});
