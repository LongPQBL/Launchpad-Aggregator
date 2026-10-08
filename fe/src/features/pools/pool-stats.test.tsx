import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PoolStats } from './pool-stats';

vi.mock('./pool-balances', () => ({ PoolBalances: () => <p>balances</p> }));

const token = (address: string, symbol: string) => ({ address: address as `0x${string}`, symbol, decimals: 18 });
const poolAddress = '0xpooolpooolpooolpooolpooolpooolpoool0000' as `0x${string}`;

describe('PoolStats', () => {
  it('derives 24H fees as volume x fee tier, not a fabricated number', () => {
    render(<PoolStats protocol="uniswap_v3" poolAddress={poolAddress} fee={3000} tvlUsd="65600" fdvUsd={null} volume24hUsd="34100" createdTimestamp={null}
      priceInQuote="0.0001" poolBalances={null} displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')} other={token('0x0000000000000000000000000000000000000000', 'ETH')} />);
    // 34100 * (3000 / 1_000_000) = 102.3
    expect(screen.getByText('$102.3')).toBeInTheDocument();
  });

  it('shows "—" for 24H fees when volume is unavailable, never a fabricated zero', () => {
    render(<PoolStats protocol="uniswap_v3" poolAddress={poolAddress} fee={3000} tvlUsd="65600" fdvUsd={null} volume24hUsd={null} createdTimestamp={null}
      priceInQuote="0.0001" poolBalances={null} displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')} other={token('0x0000000000000000000000000000000000000000', 'ETH')} />);
    expect(screen.getAllByText('—')).not.toHaveLength(0);
  });

  it('shows TVL and 24H volume', () => {
    render(<PoolStats protocol="uniswap_v3" poolAddress={poolAddress} fee={3000} tvlUsd="65600" fdvUsd={null} volume24hUsd="34100" createdTimestamp={null}
      priceInQuote="0.0001" poolBalances={null} displayed={token('0xaaaa000000000000000000000000000000aaaa', 'SANTACOIN')} other={token('0x0000000000000000000000000000000000000000', 'ETH')} />);
    expect(screen.getByText('$65.6K')).toBeInTheDocument();
    expect(screen.getByText('$34.1K')).toBeInTheDocument();
  });
});
