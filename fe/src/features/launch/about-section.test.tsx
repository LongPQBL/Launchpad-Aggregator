import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByText(baseProps.tokenAddress)).toHaveClass('break-all');
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
    const copiedButton = screen.getByRole('button', { name: 'Copied' });
    expect(copiedButton).toHaveClass('bg-black', 'text-white');
    expect(copiedButton).toHaveTextContent('0x1111…1111');
    expect(copiedButton.querySelector('span.bg-green-600')).toHaveClass('h-[14px]', 'w-[14px]');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('keeps the manual-copy fallback visible until the next attempt, not auto-dismissed like Copied', async () => {
    vi.useFakeTimers();
    try {
      setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
      render(<AboutSection {...baseProps} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /copy token address/i }));
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AboutSection website/Twitter link validation', () => {
  it('shows the address and Explorer controls with dark styling and leading icons', () => {
    render(<AboutSection {...baseProps} />);

    const copy = screen.getByRole('button', { name: 'Copy token address' });
    const explorer = screen.getByRole('link', { name: 'Explorer' });
    for (const control of [copy, explorer]) {
      expect(control).toHaveClass('bg-black', 'text-white');
      expect(control.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('shows Website and Twitter links with dark styling and leading icons', () => {
    render(<AboutSection {...baseProps} websiteUrl="https://example.com" twitterUrl="https://x.com/example" />);

    for (const name of ['Website', 'Twitter']) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveClass('bg-black', 'text-white');
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.getByRole('link', { name: 'Website' }).parentElement)
      .toBe(screen.getByRole('link', { name: 'Twitter' }).parentElement);
    expect(screen.getByRole('link', { name: 'Website' }).parentElement).toHaveClass('flex-nowrap');
  });

  it('hides the website pill for an invalid URL and shows it for a valid one', () => {
    const { rerender } = render(<AboutSection {...baseProps} websiteUrl="javascript:alert(1)" />);
    expect(screen.queryByRole('link', { name: 'Website' })).not.toBeInTheDocument();
    rerender(<AboutSection {...baseProps} websiteUrl="https://example.com" />);
    expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute('href', 'https://example.com');
  });

  it('keeps any valid http(s) Twitter URL without requiring an x.com/twitter.com host', () => {
    render(<AboutSection {...baseProps} twitterUrl="https://some-other-domain.example/profile" />);
    expect(screen.getByRole('link', { name: 'Twitter' })).toHaveAttribute('href', 'https://some-other-domain.example/profile');
  });

  it('hides the Twitter pill for a malformed URL', () => {
    render(<AboutSection {...baseProps} twitterUrl="not a url" />);
    expect(screen.queryByRole('link', { name: 'Twitter' })).not.toBeInTheDocument();
  });
});

describe('AboutSection description overflow detection', () => {
  let scrollHeight = 0;
  let clientHeight = 0;

  beforeEach(() => {
    scrollHeight = 0;
    clientHeight = 0;
    Object.defineProperty(HTMLParagraphElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(HTMLParagraphElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight });
  });

  afterEach(() => {
    // @ts-expect-error -- restoring jsdom's own default descriptor, not a real browser API
    delete HTMLParagraphElement.prototype.scrollHeight;
    // @ts-expect-error -- same as above
    delete HTMLParagraphElement.prototype.clientHeight;
  });

  it('renders no paragraph or toggle for a null description', () => {
    render(<AboutSection {...baseProps} description={null} />);
    expect(screen.queryByText(/show more/i)).not.toBeInTheDocument();
  });

  it('renders no paragraph or toggle for a whitespace-only description', () => {
    render(<AboutSection {...baseProps} description={'   \n  '} />);
    expect(screen.queryByText(/show more/i)).not.toBeInTheDocument();
  });

  it('does not show Show more when the collapsed paragraph does not overflow', () => {
    scrollHeight = 40;
    clientHeight = 60;
    render(<AboutSection {...baseProps} description="Short description." />);
    expect(screen.getByText('Short description.')).toBeInTheDocument();
    expect(screen.queryByText(/show more/i)).not.toBeInTheDocument();
  });

  it('shows Show more when the collapsed paragraph overflows, and toggles to Show less', () => {
    scrollHeight = 120;
    clientHeight = 60;
    render(<AboutSection {...baseProps} description="A very long description that wraps past three lines." />);
    const toggle = screen.getByRole('button', { name: /show more/i });
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show less/i }));
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  });

  it('preserves manual newlines via whitespace-pre-wrap', () => {
    scrollHeight = 40;
    clientHeight = 60;
    render(<AboutSection {...baseProps} description={'Line one\nLine two'} />);
    const paragraph = screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Line one\nLine two');
    expect(paragraph).toHaveClass('whitespace-pre-wrap');
  });
});
