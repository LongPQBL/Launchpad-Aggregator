import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HeaderActions } from './header-actions';

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true });
}

describe('HeaderActions', () => {
  afterEach(() => {
    setClipboard(undefined);
  });

  it('shows an X link when twitterUrl is a real http(s) url', () => {
    render(<HeaderActions twitterUrl="https://x.com/example" />);
    expect(screen.getByRole('link', { name: 'X' })).toHaveAttribute('href', 'https://x.com/example');
  });

  it('hides the X link when twitterUrl is null', () => {
    render(<HeaderActions twitterUrl={null} />);
    expect(screen.queryByRole('link', { name: 'X' })).not.toBeInTheDocument();
  });

  it('hides the X link when twitterUrl is not a real http(s) url', () => {
    render(<HeaderActions twitterUrl="javascript:alert(1)" />);
    expect(screen.queryByRole('link', { name: 'X' })).not.toBeInTheDocument();
  });

  it('copies the current page URL when Share is clicked', async () => {
    const writeText = (text: string) => { captured = text; return Promise.resolve(); };
    let captured = '';
    setClipboard({ writeText });
    render(<HeaderActions twitterUrl={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    });
    expect(captured).toBe(window.location.href);
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
  });

  it('shows a manual-copy error when the Clipboard API is unavailable', async () => {
    setClipboard(undefined);
    render(<HeaderActions twitterUrl={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not copy/i);
  });
});
