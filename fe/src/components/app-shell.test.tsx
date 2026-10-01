import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './app-shell';

describe('AppShell', () => {
  it('shows the app name and a main landmark', () => {
    render(
      <AppShell>
        <p>Content</p>
      </AppShell>,
    );

    expect(screen.getByText('Launchpad Aggregator')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).not.toHaveClass('dark');
  });

  it('does not render any wallet or trading controls', () => {
    render(
      <AppShell>
        <p>Content</p>
      </AppShell>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/ví|wallet|mua|bán|buy|sell/i)).not.toBeInTheDocument();
  });
});
