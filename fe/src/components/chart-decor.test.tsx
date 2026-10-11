import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartDimAfter, ChartLeftFade, ChartLiveDot } from './chart-decor';

afterEach(() => { vi.restoreAllMocks(); });

function fakeChart(x: number | null, width = 600) {
  return { timeScale: () => ({ timeToCoordinate: () => x, width: () => width }), paneSize: () => ({ width, height: 300 }) };
}
const fakeSeries = (y: number | null) => ({ priceToCoordinate: () => y });
const frames = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

describe('ChartLiveDot', () => {
  it('puts a pulsing dot on the newest point, from the series coordinates', async () => {
    render(<div><ChartLiveDot chart={fakeChart(120) as never} series={fakeSeries(80) as never} point={{ time: 10, value: 5 }} /></div>);
    await frames();
    const dot = screen.getByTestId('chart-live-dot');
    expect(dot).toHaveStyle({ left: '115px', top: '75px' });
    expect(dot.querySelector('.chart-live-ping')).not.toBeNull();
  });
  it('draws nothing without a point, or when the point is outside the visible plot', async () => {
    const { rerender } = render(<ChartLiveDot chart={fakeChart(120) as never} series={fakeSeries(80) as never} point={null} />);
    await frames();
    expect(screen.queryByTestId('chart-live-dot')).toBeNull();
    rerender(<ChartLiveDot chart={fakeChart(900) as never} series={fakeSeries(80) as never} point={{ time: 10, value: 5 }} />);
    await frames();
    expect(screen.queryByTestId('chart-live-dot')).toBeNull();
    rerender(<ChartLiveDot chart={fakeChart(null) as never} series={fakeSeries(80) as never} point={{ time: 10, value: 5 }} />);
    await frames();
    expect(screen.queryByTestId('chart-live-dot')).toBeNull();
  });
  it('survives a chart that was already removed', async () => {
    const removed = { timeScale: () => { throw new Error('Object is disposed'); }, paneSize: () => ({ height: 1 }) };
    render(<ChartLiveDot chart={removed as never} series={fakeSeries(1) as never} point={{ time: 1, value: 1 }} />);
    await frames();
    expect(screen.queryByTestId('chart-live-dot')).toBeNull();
  });
});

describe('ChartDimAfter / ChartLeftFade', () => {
  it('dims from the pointer to the right edge, and not at all when there is no pointer', () => {
    const { rerender } = render(<ChartDimAfter x={200} />);
    expect(screen.getByTestId('chart-dim')).toHaveStyle({ left: '200px' });
    rerender(<ChartDimAfter x={null} />);
    expect(screen.queryByTestId('chart-dim')).toBeNull();
  });
  it('renders the left fade as a non-interactive overlay', () => {
    const { container } = render(<ChartLeftFade />);
    expect(container.firstElementChild).toHaveStyle({ pointerEvents: 'none' });
  });
});
