import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { openWalletDialog } from '@/wallet/open-wallet-dialog';
import { SwapTrigger } from './swap-trigger';

vi.mock('@/trading/swap-panel', () => ({ SwapPanel: () => <div>v3 panel</div> }));
vi.mock('@/trading/v4-swap-panel', () => ({ V4SwapPanel: () => <div>v4 panel</div> }));

const props = {
  protocol: 'uniswap_v4' as const,
  poolId: `0x${'a'.repeat(64)}` as `0x${string}`,
  tokenA: { address: '0x1111111111111111111111111111111111111111' as const, symbol: 'AAA', decimals: 18, logoUri: null },
  tokenB: { address: '0x2222222222222222222222222222222222222222' as const, symbol: 'BBB', decimals: 18, logoUri: null },
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000' as const,
  explorerBase: null,
};

describe('SwapTrigger', () => {
  // The header's wallet dialog is earlier in the DOM than this swap dialog and both are
  // `fixed inset-0 z-50`, so a still-open swap dialog would cover it: "Connect" must close it.
  it('closes its swap dialog when a panel asks the header to open the wallet dialog', () => {
    render(<SwapTrigger {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(screen.getByRole('dialog', { name: 'AAA / BBB' })).toBeInTheDocument();
    act(() => openWalletDialog());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores the wallet-dialog event while its own dialog is closed and still opens afterwards', () => {
    render(<SwapTrigger {...props} />);
    act(() => openWalletDialog());
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(screen.getByRole('dialog', { name: 'AAA / BBB' })).toBeInTheDocument();
  });
});
