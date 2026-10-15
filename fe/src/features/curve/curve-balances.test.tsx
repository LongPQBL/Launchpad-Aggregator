import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getCurveDepth: vi.fn() }));
vi.mock('wagmi', () => ({ useBalance: () => ({ data: undefined }), useReadContract: () => ({ data: undefined }) }));
vi.mock('@/wallet/config', () => ({ robinhoodChain: { id: 4663 } }));

import { getCurveDepth } from '@/api/client';
import { CurveBalances } from './curve-balances';

const token = { address: `0x${'a1'.repeat(20)}` as `0x${string}`, symbol: 'EAR', decimals: 18 };
const quote = { address: '0x0000000000000000000000000000000000000000' as `0x${string}`, symbol: 'ETH', decimals: 18 };
const curve = `0x${'c2'.repeat(20)}` as `0x${string}`;
const e18 = 10n ** 18n;
// A curve with a VIRTUAL quote reserve of 4: quoteReserve is 6, but only 2 was paid in.
const depth = (overrides: Record<string, unknown> = {}) => ({ blockNumber: '1', price: 0.000004, priceInverse: 250_000, feeBps: 100, creatorTaxBps: 0, graduationThreshold: String(10n * e18),
  realQuoteReserve: String(2n * e18), quoteReserve: String(6n * e18), tokenReserve: String(1_000_000n * e18), quoteDecimals: 18, tokenDecimals: 18, tokenBalance: String(900_000n * e18),
  asksEndAtGraduation: false, bidsEndAtEmptyReserve: false, depth: null, complete: true, unavailableReason: null, ...overrides }) as never;

describe('CurveBalances', () => {
  beforeEach(() => { vi.mocked(getCurveDepth).mockReset(); });

  it('shows the token balance of the curve and the quote really paid in, not the virtual quote reserve', async () => {
    vi.mocked(getCurveDepth).mockResolvedValue(depth());
    render(<CurveBalances chainId={4663} curveAddress={curve} token={token} quote={quote} />);
    const side = (text: string) => screen.queryByText((_, element) => element?.tagName === 'SPAN' && element.textContent === text);
    await waitFor(() => expect(side('900K EAR')).toBeInTheDocument());
    expect(side('2 ETH')).toBeInTheDocument(); // the 2 paid in, not the 6 of the virtual reserve
    expect(side('6 ETH')).not.toBeInTheDocument();
  });

  it('says the balances are unavailable when the curve answer has no real balances (never a guess)', async () => {
    vi.mocked(getCurveDepth).mockResolvedValue(depth({ tokenBalance: null }));
    render(<CurveBalances chainId={4663} curveAddress={curve} token={token} quote={quote} />);
    await waitFor(() => expect(screen.getByText('Curve balances unavailable')).toBeInTheDocument());
  });

  it('says they are unavailable when the request fails', async () => {
    vi.mocked(getCurveDepth).mockRejectedValue(new Error('down'));
    render(<CurveBalances chainId={4663} curveAddress={curve} token={token} quote={quote} />);
    await waitFor(() => expect(screen.getByText('Curve balances unavailable')).toBeInTheDocument());
  });
});
