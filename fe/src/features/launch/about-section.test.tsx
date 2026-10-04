import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutSection } from './about-section';

const baseProps = {
  description: null as string | null,
  tokenAddress: '0x1111111111111111111111111111111111111111',
  explorerUrl: 'https://robinhoodchain.blockscout.com/token/0x1111111111111111111111111111111111111111',
  websiteUrl: null as string | null,
  twitterUrl: null as string | null,
};

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true });
}

describe('AboutSection copy-address control', () => {
  afterEach(() => {
    setClipboard(undefined);
  });

  it('shows a manual-copy fallback when the Clipboard API does not exist', async () => {
    setClipboard(undefined);
    render(<AboutSection {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(baseProps.tokenAddress);
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('shows a manual-copy fallback when the write is rejected', async () => {
    setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
    render(<AboutSection {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(baseProps.tokenAddress);
  });

  it('shows Copied after a successful write, and clears it on the next attempt', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<AboutSection {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
    });
    expect(writeText).toHaveBeenCalledWith(baseProps.tokenAddress);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });
});
