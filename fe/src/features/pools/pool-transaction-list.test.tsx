import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getPoolTrades, type PoolSummary, type PoolTrade } from '@/api/client';
import { emitPoolChanged } from '@/hooks/live-events';
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getPoolTrades: vi.fn() }));

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
    expect(screen.getAllByRole('cell').map((c) => c.textContent)).toContain('1');
    expect(screen.getByText(/^2 ETH$/)).toBeInTheDocument();
  });

  it('swaps which raw amount is "displayed" when the displayed token is currency1', () => {
    render(<PoolTransactionList trades={[trade()]} displayedSymbol="ETH" otherSymbol="SANTACOIN"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0={false} explorerBase={null} />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/^1 SANTACOIN$/)).toBeInTheDocument();
  });

  it('shows the size of each leg without the pool-side minus sign', () => {
    render(<PoolTransactionList trades={[trade({ amount0Raw: '-3000000000000000000', amount1Raw: '190000000000000000' })]} displayedSymbol="NDA" otherSymbol="USDG"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase={null} />);
    expect(screen.getAllByRole('cell').map((c) => c.textContent)).toContain('3');
    expect(screen.queryByText(/^-/)).not.toBeInTheDocument();
    expect(screen.getByText(/^0\.19 USDG$/)).toBeInTheDocument();
  });

  it('shows a dash, never "Calculating", for a USD value that is not known yet', () => {
    render(<PoolTransactionList trades={[trade({ usdValue: null, usdValueStatus: 'pending' })]} displayedSymbol="NDA" otherSymbol="USDG"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase={null} />);
    expect(screen.queryByText(/Calculating/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('cell')[2]).toHaveTextContent('—');
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

  it('links the wallet and tx hash to the explorer when one is known', () => {
    render(<PoolTransactionList trades={[trade()]} displayedSymbol="SANTACOIN" otherSymbol="ETH"
      displayedDecimals={18} otherDecimals={18} displayedIsCurrency0 explorerBase="https://explorer.example" />);
    expect(screen.getByRole('link', { name: /0x1234/ })).toHaveAttribute('href', 'https://explorer.example/address/0x1234567890123456789012345678901234567890');
    expect(screen.getByRole('link', { name: /0xabc/ })).toHaveAttribute('href', 'https://explorer.example/tx/0xabc');
  });

  describe('live swaps', () => {
    const livePool = { chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'ab'.repeat(32)}`, displayedToken: '0x1' } as PoolSummary;
    const props = { displayedSymbol: 'A', otherSymbol: 'ETH', displayedDecimals: 18, otherDecimals: 18, displayedIsCurrency0: true, explorerBase: null } as const;

    it('merges a swap announced in this pool at the top without a page refresh', async () => {
      vi.mocked(getPoolTrades).mockResolvedValue({ items: [trade({ txHash: '0xnew', blockNumber: '101' }), trade()], nextCursor: null });
      render(<PoolTransactionList {...props} trades={[trade()]} livePool={livePool} />);
      expect(screen.getAllByRole('row')).toHaveLength(2);
      await act(async () => { emitPoolChanged({ chainId: 4663, poolId: livePool.poolId }); });
      expect(getPoolTrades).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('row')).toHaveLength(3);
    });

    it('ignores a swap in another pool', async () => {
      vi.mocked(getPoolTrades).mockClear();
      render(<PoolTransactionList {...props} trades={[trade()]} livePool={livePool} />);
      await act(async () => { emitPoolChanged({ chainId: 4663, poolId: `0x${'cd'.repeat(32)}` }); });
      expect(getPoolTrades).not.toHaveBeenCalled();
    });
  });
});
