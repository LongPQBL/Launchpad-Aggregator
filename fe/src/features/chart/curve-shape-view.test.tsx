import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildCurveShape } from './curve-shape';
import { CurveShapeView } from './curve-shape-view';

const e18 = 1e18;
const shape = buildCurveShape({ quoteReserve: String(4 * e18), tokenReserve: String(1_000_000 * e18), realQuoteReserve: String(2 * e18),
  graduationThreshold: String(10 * e18), quoteDecimals: 18, tokenDecimals: 18 })!;

describe('CurveShapeView', () => {
  it('draws the bought part solid, the rest dashed, and marks the current point and graduation', () => {
    render(<CurveShapeView shape={shape} baseSymbol="EAR" quoteSymbol="ETH" />);
    expect(screen.getByRole('img', { name: 'Bonding curve chart' })).toBeInTheDocument();
    expect(screen.getByTestId('curve-done')).toBeInTheDocument();
    expect(screen.getByTestId('curve-ahead')).toHaveAttribute('stroke-dasharray');
    expect(screen.getByTestId('curve-now')).toBeInTheDocument();
    expect(screen.getByTestId('curve-graduation')).toBeInTheDocument();
  });
  it('reads the current price, progress and tokens sold, and the hovered point while the pointer is on the chart', () => {
    render(<CurveShapeView shape={shape} baseSymbol="EAR" quoteSymbol="ETH" />);
    const readout = screen.getByTestId('curve-shape-readout');
    expect(readout).toHaveTextContent('0.000004 ETH');
    expect(readout).toHaveTextContent('Now at 20.0% of graduation');
    expect(readout).toHaveTextContent('1.00M EAR sold');
    const svg = screen.getByRole('img', { name: 'Bonding curve chart' });
    svg.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 320, right: 600, bottom: 320, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseMove(svg, { clientX: 598 });
    expect(readout).toHaveTextContent('At 100.0% of graduation');
    fireEvent.mouseLeave(svg);
    expect(readout).toHaveTextContent('Now at 20.0% of graduation');
  });
});
