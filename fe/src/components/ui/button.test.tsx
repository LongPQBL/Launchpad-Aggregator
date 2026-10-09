import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('uses a pointer cursor only while enabled', () => {
    const { rerender } = render(<Button>Action</Button>);
    expect(screen.getByRole('button', { name: 'Action' })).toHaveClass('enabled:cursor-pointer');

    rerender(<Button disabled>Action</Button>);
    expect(screen.getByRole('button', { name: 'Action' })).toHaveClass('enabled:cursor-pointer');
  });

  it('uses a subtle foreground tint for outline and ghost hover backgrounds', () => {
    const { rerender } = render(<Button variant="outline">Outline</Button>);
    expect(screen.getByRole('button', { name: 'Outline' })).toHaveClass('hover:bg-foreground/5', 'hover:text-foreground');

    rerender(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole('button', { name: 'Ghost' })).toHaveClass('hover:bg-foreground/5', 'hover:text-foreground');
  });
});
