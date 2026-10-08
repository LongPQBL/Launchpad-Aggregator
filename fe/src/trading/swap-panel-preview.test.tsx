import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SwapPanelPreview } from './swap-panel-preview';

describe('SwapPanelPreview', () => {
  it('renders the swap card layout with fake data, clearly labeled preview-only and disabled', () => {
    render(<SwapPanelPreview sellSymbol="TOK" buySymbol="ETH" />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText(/preview only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview only/i })).toBeDisabled();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
