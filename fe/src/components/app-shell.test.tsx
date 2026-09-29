import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './app-shell';

describe('AppShell', () => {
  it('shows the app name, a main landmark, and dark theme', () => {
    render(
      <AppShell>
        <p>Nội dung</p>
      </AppShell>,
    );

    expect(screen.getByText('Launchpad Aggregator')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toHaveClass('dark');
  });

  it('does not render any wallet or trading controls', () => {
    render(
      <AppShell>
        <p>Nội dung</p>
      </AppShell>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/ví|wallet|mua|bán|buy|sell/i)).not.toBeInTheDocument();
  });
});
