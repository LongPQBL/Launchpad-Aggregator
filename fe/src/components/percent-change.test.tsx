import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PercentChange } from './percent-change';

// jsdom makes React listen for the vendor-prefixed event name, so that is what ends a roll in tests.
const settleRolls = () => act(() => {
  screen.queryAllByTestId('digit-roll').forEach((el) => el.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true })));
});

describe('PercentChange', () => {
  it('colors only the arrow; the number stays a soft white', () => {
    render(<PercentChange value="-11.43" />);
    const arrow = screen.getByText('▼');
    expect(arrow.className).toContain('text-destructive');
    const wrapper = arrow.parentElement!;
    expect(wrapper.className).toContain('text-foreground/70');
    expect(wrapper.textContent).toBe('▼11.43%');
  });
  it('uses an up arrow for gains and no arrow for zero', () => {
    const { unmount } = render(<PercentChange value="5" />);
    expect(screen.getByText('▲').className).toContain('text-success');
    unmount();
    render(<PercentChange value="0" />);
    expect(screen.queryByText('▲')).toBeNull();
    expect(screen.queryByText('▼')).toBeNull();
  });
});

describe('PercentChange rolling digits', () => {
  it('does not animate on first render', () => {
    render(<PercentChange value="24.78" />);
    expect(screen.queryByTestId('digit-roll')).toBeNull();
  });
  it('rolls only the digits that changed, upward when the value rose', () => {
    const { rerender, container } = render(<PercentChange value="24.78" />);
    rerender(<PercentChange value="25.78" />);
    const rolls = screen.getAllByTestId('digit-roll');
    expect(rolls).toHaveLength(1);
    expect(rolls[0].getAttribute('data-direction')).toBe('up');
    expect(rolls[0].textContent).toBe('45');
    expect(container.querySelector('[aria-hidden="true"]:not(.text-xs)')?.textContent).toBe('4');
  });
  it('rolls downward when the value fell', () => {
    const { rerender } = render(<PercentChange value="25.78" />);
    rerender(<PercentChange value="24.78" />);
    expect(screen.getByTestId('digit-roll').getAttribute('data-direction')).toBe('down');
  });
  it('settles to the plain new digit once the animation ends', () => {
    const { rerender } = render(<PercentChange value="24.78" />);
    rerender(<PercentChange value="25.78" />);
    settleRolls();
    expect(screen.queryByTestId('digit-roll')).toBeNull();
  });
});
