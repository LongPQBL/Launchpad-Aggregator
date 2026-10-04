import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenLogo } from './token-logo';

describe('TokenLogo', () => {
  afterEach(() => {
    // @ts-expect-error -- restoring jsdom's own default descriptor, not a real browser API
    delete HTMLImageElement.prototype.complete;
    // @ts-expect-error -- same as above
    delete HTMLImageElement.prototype.naturalWidth;
  });

  it('falls back to the placeholder when the image already finished failing before mount (SSR hydration race)', () => {
    // Simulates a real browser where the server-rendered <img> started loading from the raw HTML
    // stream and already failed (404/429) before React's client JS hydrates and attaches onError
    // — the native error event fired too early for any onError handler to catch it
    // (final-review Important 4). jsdom never truly loads images, so this is the only way to
    // simulate "the browser already knows this failed" at mount time.
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 0 });

    render(<TokenLogo logoUri="https://example.com/logo.png" symbol="TKA" />);

    expect(screen.queryByRole('img', { name: /token logo/i })).not.toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('renders the real image when it has not already failed at mount time', () => {
    render(<TokenLogo logoUri="https://example.com/logo.png" symbol="TKA" />);

    expect(screen.getByRole('img', { name: /token logo/i })).toBeInTheDocument();
  });

  it('shows the Robinhood Chain badge even when the token logo is unavailable', () => {
    render(<TokenLogo logoUri={null} symbol="TKA" chainId={4663} />);

    expect(screen.getByRole('img', { name: 'Robinhood Chain' })).toHaveAttribute(
      'src',
      expect.stringContaining('/images/chains/robinhood-chain.png'),
    );
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('does not show a Robinhood badge for another chain', () => {
    render(<TokenLogo logoUri={null} symbol="TKA" chainId={1} />);

    expect(screen.queryByRole('img', { name: 'Robinhood Chain' })).not.toBeInTheDocument();
  });

  it('falls back to the placeholder for a malformed logo URI', () => {
    render(<TokenLogo logoUri="javascript:alert(1)" symbol="TKA" />);
    expect(screen.queryByRole('img', { name: /token logo/i })).not.toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('falls back to the placeholder for an empty ipfs:// CID', () => {
    render(<TokenLogo logoUri="ipfs://" symbol="TKA" />);
    expect(screen.queryByRole('img', { name: /token logo/i })).not.toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
  });
});
