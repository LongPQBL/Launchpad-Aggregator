import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenCell } from './token-cell';

const tokenAddress = '0x2E8c1234567890123456789012345678901e18';

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true });
}

describe('TokenCell', () => {
  afterEach(() => {
    setClipboard(undefined);
  });

  it('shows the symbol and the truncated address stacked under the name, both always in the DOM', () => {
    render(<TokenCell chainId={4663} tokenAddress={tokenAddress} name="Artificial Inu" symbol="AI" logoUri={null} lifecycleStatus="trading" />);
    expect(screen.getByRole('link', { name: 'Artificial Inu' })).toBeInTheDocument();
    expect(screen.getByTestId('token-symbol')).toHaveTextContent('AI');
    expect(screen.getByRole('button', { name: 'Copy token address' })).toHaveTextContent('0x2E8c…1e18');
  });

  it('copies the full token address to the clipboard and shows transient confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<TokenCell chainId={4663} tokenAddress={tokenAddress} name="Artificial Inu" symbol="AI" logoUri={null} lifecycleStatus="trading" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy token address' }));
    });

    expect(writeText).toHaveBeenCalledWith(tokenAddress);
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveTextContent('Copied');
  });
});
