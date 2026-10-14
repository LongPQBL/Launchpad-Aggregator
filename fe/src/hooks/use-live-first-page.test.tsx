import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTradeCreated } from './live-events';
import { useLiveFirstPage } from './use-live-first-page';

function Probe({ fetchFirstPage }: { fetchFirstPage: () => Promise<void> }) {
  useLiveFirstPage(() => true, fetchFirstPage, []);
  return null;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { setHidden(false); vi.useRealTimers(); });

describe('useLiveFirstPage', () => {
  it('skips events while the tab is hidden and fetches once when it becomes visible again', async () => {
    const fetchFirstPage = vi.fn(async () => {});
    render(<Probe fetchFirstPage={fetchFirstPage} />);
    setHidden(true);
    await act(async () => { emitTradeCreated({ chainId: 1 }); emitTradeCreated({ chainId: 1 }); });
    expect(fetchFirstPage).not.toHaveBeenCalled();
    await act(async () => { setHidden(false); });
    expect(fetchFirstPage).toHaveBeenCalledTimes(1);
    await act(async () => { setHidden(true); setHidden(false); });
    expect(fetchFirstPage).toHaveBeenCalledTimes(1); // nothing was missed the second time
  });

  it('fetches at once for the first event and folds a burst into one trailing fetch a second later', async () => {
    const fetchFirstPage = vi.fn(async () => {});
    render(<Probe fetchFirstPage={fetchFirstPage} />);
    await act(async () => { for (let i = 0; i < 4; i += 1) emitTradeCreated({ chainId: 1 }); });
    expect(fetchFirstPage).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(fetchFirstPage).toHaveBeenCalledTimes(2);
  });
});
