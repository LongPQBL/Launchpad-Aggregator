import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurveDepth, getPoolLiquidity } from '@/api/client';
import { emitPoolChanged, emitTradeCreated } from '@/hooks/live-events';
import { CurveDepthChart, formatLiquidity, PoolDepthChart, PoolLiquidityChart } from './pool-liquidity';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getPoolLiquidity: vi.fn(), getCurveDepth: vi.fn() }));

const pool = { chainId: 4663, protocol: 'uniswap_v3', poolId: '0xpool', currency0Symbol: 'ETH', currency1Symbol: 'USDC' } as never;
const depth = { asks: [{ price: 2541, amount0: 30, total1: 76_000, cumulative1: 76_000 }], bids: [{ price: 2539, amount0: 30, total1: 76_000, cumulative1: 76_000 }], spreadPercent: 0.1 };
const liquidity = (overrides: Record<string, unknown> = {}) => ({ blockNumber: '1', tickSpacing: 10, feePips: 500, currentTick: 0, price: 2540, priceInverse: 0.000394,
  token0: { address: '0xa', decimals: 18 }, token1: { address: '0xb', decimals: 18 },
  ranges: [{ tickLower: -100, tickUpper: 100, priceLower: 0.99, priceUpper: 1.01, liquidity: '1000', active: true }, { tickLower: 100, tickUpper: 300, priceLower: 1.01, priceUpper: 1.03, liquidity: '400', active: false }],
  depth, complete: true, unavailableReason: null, ...overrides }) as never;

beforeEach(() => { vi.mocked(getPoolLiquidity).mockReset(); vi.mocked(getCurveDepth).mockReset(); });

describe('PoolLiquidityChart', () => {
  it('shows a loading state, then the price in both directions and one bar per slice of liquidity, the active range marked', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValue(liquidity());
    render(<PoolLiquidityChart pool={pool} />);
    expect(screen.getByRole('status', { name: 'Loading liquidity' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('liquidity-readout')).toHaveTextContent('1 ETH = 2,540 USDC'));
    expect(screen.getByTestId('liquidity-readout')).toHaveTextContent('1 USDC = 0.000394 ETH');
    const bars = screen.getAllByTestId('liquidity-bar');
    expect(bars.length).toBeGreaterThan(5);
    expect(bars.some((bar) => bar.getAttribute('data-active') === 'true')).toBe(true);
    expect(bars.some((bar) => bar.getAttribute('data-active') === 'false')).toBe(true);
    expect(screen.getByTestId('liquidity-current')).toBeInTheDocument();
  });
  it('says why there is no chart: no liquidity, an unavailable read, a failed request', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValueOnce(liquidity({ ranges: [] }));
    const { unmount } = render(<PoolLiquidityChart pool={pool} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('no liquidity right now'));
    unmount();
    vi.mocked(getPoolLiquidity).mockResolvedValueOnce(liquidity({ complete: false, unavailableReason: 'liquidity_mismatch', ranges: [], depth: null, price: null }));
    const second = render(<PoolLiquidityChart pool={pool} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('do not add up'));
    second.unmount();
    vi.mocked(getPoolLiquidity).mockRejectedValueOnce(new Error('down'));
    render(<PoolLiquidityChart pool={pool} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load'));
  });
  it('shows the price range and liquidity of the bar under the pointer', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValue(liquidity());
    const { container } = render(<PoolLiquidityChart pool={pool} />);
    await waitFor(() => expect(screen.getAllByTestId('liquidity-bar').length).toBeGreaterThan(0));
    const hits = container.querySelectorAll('rect[fill="transparent"]');
    fireEvent.mouseEnter(hits[40]!); // the bin at the current tick
    expect(screen.getByTestId('liquidity-hover')).toHaveTextContent('Liquidity');
    expect(screen.getByTestId('liquidity-hover')).toHaveTextContent('USDC');
  });
});

describe('formatLiquidity', () => {
  it('keeps small values compact and shows huge raw liquidity in scientific notation', () => {
    expect(formatLiquidity(1500)).toBe('1.5K');
    expect(formatLiquidity(1.5e18)).toBe('1.50e+18');
  });
});

describe('PoolDepthChart', () => {
  it('draws the order book with the spread twice the fee tier', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValue(liquidity());
    render(<PoolDepthChart pool={pool} />);
    await waitFor(() => expect(screen.getByTestId('depth-spread')).toHaveTextContent('Spread 0.1% (Fee tier 0.05%)'));
    expect(screen.getByText('Price (USDC)')).toBeInTheDocument();
  });
  it('explains an unavailable pool instead of drawing', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValue(liquidity({ complete: false, unavailableReason: 'accounting_unverified', depth: null, price: null, ranges: [] }));
    render(<PoolDepthChart pool={pool} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('hook manages liquidity'));
  });
});

describe('CurveDepthChart', () => {
  const curve = (overrides: Record<string, unknown> = {}) => ({ blockNumber: '1', price: 0.000004, priceInverse: 250_000, feeBps: 100, creatorTaxBps: 100, asksEndAtGraduation: true, bidsEndAtEmptyReserve: false,
    depth: { ...depth, spreadPercent: 2 }, complete: true, unavailableReason: null, ...overrides }) as never;
  it('shows the curve depth and its spread, with no notes under it', async () => {
    vi.mocked(getCurveDepth).mockResolvedValue(curve());
    render(<CurveDepthChart chainId={4663} tokenAddress="0xtoken" baseSymbol="TKN" quoteSymbol="ETH" />);
    await waitFor(() => expect(screen.getByTestId('depth-spread')).toHaveTextContent('Spread 2% (Fee 1%)'));
    expect(screen.queryByText(/creator tax/)).not.toBeInTheDocument();
    expect(screen.queryByText(/graduates the curve/)).not.toBeInTheDocument();
  });
  it('says the curve has graduated, or that there is no curve', async () => {
    vi.mocked(getCurveDepth).mockResolvedValueOnce(curve({ complete: false, unavailableReason: 'graduated', depth: null, price: null }));
    const { unmount } = render(<CurveDepthChart chainId={4663} tokenAddress="0xtoken" baseSymbol="TKN" quoteSymbol="ETH" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('graduated'));
    unmount();
    vi.mocked(getCurveDepth).mockResolvedValueOnce(null);
    render(<CurveDepthChart chainId={4663} tokenAddress="0xtoken" baseSymbol="TKN" quoteSymbol="ETH" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('no bonding curve'));
  });
});

describe('live updates', () => {
  it('rereads the price when a swap lands in this pool, keeping the chart on screen, and ignores other pools', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValueOnce(liquidity());
    render(<PoolLiquidityChart pool={pool} />);
    await waitFor(() => expect(screen.getByTestId('liquidity-readout')).toHaveTextContent('1 ETH = 2,540 USDC'));
    vi.mocked(getPoolLiquidity).mockResolvedValueOnce(liquidity({ price: 2600 }));
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: '0xother' }); });
    expect(getPoolLiquidity).toHaveBeenCalledTimes(1);
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: '0xpool' }); });
    expect(getPoolLiquidity).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status', { name: 'Loading liquidity' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('liquidity-readout')).toHaveTextContent('1 ETH = 2,600 USDC'));
  });

  it('rereads the curve depth when a trade of the launch is announced', async () => {
    vi.mocked(getCurveDepth).mockResolvedValue({ complete: true, unavailableReason: null, price: 2, depth, feeBps: 100, asksEndAtGraduation: false, bidsEndAtEmptyReserve: false } as never);
    render(<CurveDepthChart chainId={4663} tokenAddress="0xAbC" baseSymbol="TKN" quoteSymbol="ETH" />);
    await waitFor(() => expect(screen.getByText(/1 TKN = 2 ETH/)).toBeInTheDocument());
    await act(async () => { emitTradeCreated({ chainId: 4663, tokenAddress: '0xother' }); });
    expect(getCurveDepth).toHaveBeenCalledTimes(1);
    await act(async () => { emitTradeCreated({ chainId: 4663, tokenAddress: '0xabc' }); });
    expect(getCurveDepth).toHaveBeenCalledTimes(2);
  });
});
