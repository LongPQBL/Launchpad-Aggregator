import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './dialog';

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(<Dialog open={false} onClose={vi.fn()} title="Swap">content</Dialog>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the title and children when open', () => {
    render(<Dialog open onClose={vi.fn()} title="Swap"><p>panel body</p></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Swap' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('panel body')).toBeInTheDocument();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Swap">content</Dialog>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the X button is clicked', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Swap">content</Dialog>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Swap">content</Dialog>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
