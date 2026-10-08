import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PoolBalances } from './pool-balances';

const hooks = vi.hoisted(() => ({
  nativeBalance: { data: undefined as { value: bigint } | undefined },
  erc20Balance: undefined as bigint | undefined,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useBalance: () => hooks.nativeBalance,
  useReadContract: () => ({ data: hooks.erc20Balance }),
}));

const poolAddress = '0xpooolpooolpooolpooolpooolpooolpoool0000' as `0x${string}`;
const token = (address: string, symbol: string, decimals = 18) => ({ address: address as `0x${string}`, symbol, decimals });

describe('PoolBalances', () => {
  it('shows an unavailable state for V4 when the API has no pool-specific balance snapshot', () => {
    render(<PoolBalances protocol="uniswap_v4" poolAddress={poolAddress}
      displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')}
      other={token('0x0000000000000000000000000000000000000000', 'ETH')} priceInQuote="0.0001" poolBalances={null} />);
    expect(screen.getByText(/pool balances unavailable/i)).toBeInTheDocument();
  });

  it('shows V4 balances and a value-weighted composition bar from the API snapshot', () => {
    render(<PoolBalances protocol="uniswap_v4" poolAddress={poolAddress}
      displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')}
      other={token('0x0000000000000000000000000000000000000000', 'ETH')} priceInQuote={null}
      poolBalances={{ displayedAmountRaw: (100_000_000n * 10n ** 18n).toString(),
        otherAmountRaw: (12n * 10n ** 18n).toString(), priceInQuote: '0.0000001' }} />);
    expect(screen.getByText(/100M SANTACOIN/)).toBeInTheDocument();
    expect(screen.getByText(/12 ETH/)).toBeInTheDocument();
    const bar = screen.getByRole('img', { name: 'Pool composition' });
    const displayedSide = bar.firstElementChild as HTMLElement;
    expect(Number.parseFloat(displayedSide.style.width)).toBeCloseTo((10 / 22) * 100);
  });

  it('keeps a finite neutral composition bar for a zero-value V4 pool', () => {
    render(<PoolBalances protocol="uniswap_v4" poolAddress={poolAddress}
      displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')}
      other={token('0x0000000000000000000000000000000000000000', 'ETH')} priceInQuote={null}
      poolBalances={{ displayedAmountRaw: '0', otherAmountRaw: '0', priceInQuote: '1' }} />);
    const bar = screen.getByRole('img', { name: 'Pool composition' });
    const widths = Array.from(bar.children, (side) => Number.parseFloat((side as HTMLElement).style.width));
    expect(widths).toEqual([50, 50]);
    expect(widths.every((width) => Number.isFinite(width) && width >= 0 && width <= 100)).toBe(true);
  });

  it('shows real on-chain balances and a value-weighted composition bar for a V3 pool', () => {
    hooks.erc20Balance = 100_000_000n * 10n ** 18n; // 100M SANTACOIN
    hooks.nativeBalance = { data: { value: 12n * 10n ** 18n } }; // 12 ETH
    render(<PoolBalances protocol="uniswap_v3" poolAddress={poolAddress}
      displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')}
      other={token('0x0000000000000000000000000000000000000000', 'ETH')} priceInQuote="0.0001" poolBalances={null} />);
    expect(screen.getByText(/100M SANTACOIN/)).toBeInTheDocument();
    expect(screen.getByText(/12 ETH/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pool composition' })).toBeInTheDocument();
  });

  it('shows a loading state while on-chain reads are pending, not a fabricated zero', () => {
    hooks.erc20Balance = undefined;
    hooks.nativeBalance = { data: undefined };
    render(<PoolBalances protocol="uniswap_v3" poolAddress={poolAddress}
      displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')}
      other={token('0x0000000000000000000000000000000000000000', 'ETH')} priceInQuote="0.0001" poolBalances={null} />);
    expect(screen.getByText(/loading pool balances/i)).toBeInTheDocument();
  });
});
