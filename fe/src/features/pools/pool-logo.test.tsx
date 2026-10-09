import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PoolLogo } from './pool-logo';

describe('PoolLogo', () => {
  it('renders both token images when logos are available', () => {
    render(<PoolLogo
      token0={{ symbol: 'GUY', logoUri: 'https://example.com/guy.png' }}
      token1={{ symbol: 'ETH', logoUri: 'https://example.com/eth.png' }}
    />);
    const images = screen.getAllByRole('img', { name: /token logo/i });
    expect(images).toHaveLength(2);
  });

  it('falls back to each side\'s initial letter when that side has no logo', () => {
    render(<PoolLogo token0={{ symbol: 'GUY', logoUri: null }} token1={{ symbol: 'ETH', logoUri: null }} />);
    expect(screen.getByText('G')).toBeInTheDocument();
    expect(screen.getByText('E')).toBeInTheDocument();
  });

  it('shows the Robinhood Chain badge in the corner for chain 4663', () => {
    render(<PoolLogo token0={{ symbol: 'GUY', logoUri: null }} token1={{ symbol: 'ETH', logoUri: null }} chainId={4663} />);
    expect(screen.getByRole('img', { name: 'Robinhood Chain' })).toHaveAttribute(
      'src', expect.stringContaining('/images/chains/robinhood-chain.png'),
    );
  });

  it('does not show a chain badge for another chain', () => {
    render(<PoolLogo token0={{ symbol: 'GUY', logoUri: null }} token1={{ symbol: 'ETH', logoUri: null }} chainId={1} />);
    expect(screen.queryByRole('img', { name: 'Robinhood Chain' })).not.toBeInTheDocument();
  });
});

describe('PoolLogo size', () => {
  it('renders smaller circles for list rows than for page headers', () => {
    const tokens = { token0: { symbol: 'AAA', logoUri: null }, token1: { symbol: 'BBB', logoUri: null } };
    const { container: header } = render(<PoolLogo {...tokens} />);
    const { container: row } = render(<PoolLogo {...tokens} size="small" />);
    expect(header.querySelectorAll('.h-12.w-12')).toHaveLength(4);
    expect(row.querySelectorAll('.h-9.w-9')).toHaveLength(4);
    expect(row.querySelector('.h-12')).toBeNull();
  });
});
