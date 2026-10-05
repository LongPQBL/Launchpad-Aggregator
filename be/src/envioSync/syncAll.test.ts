import { describe, expect, it, vi } from 'vitest';
import { STREAMS } from './incrementalCursor.js';

vi.mock('./incrementalCursor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./incrementalCursor.js')>();
  return { ...actual, detectEnvioRollback: vi.fn(async () => false) };
});
vi.mock('./incrementalRepair.js', () => ({
  repairEnvioWindow: vi.fn(async () => ({ changedLaunchKeys: [] })),
  recordRepairOutcome: vi.fn(async () => undefined),
}));

vi.mock('./runSync.js', () => ({
  syncV1LegacyOnce: vi.fn(async () => ({ launchesWritten: 0, tradesWritten: 0 })),
  syncV1LegacyToReal: vi.fn(async () => ({ launchesWritten: 1, tradesWritten: 1 })),
  DEFAULT_ENVIO_TABLES: { rawLaunchTable: 'envio."RawLaunch"', rawSwapTable: 'envio."RawSwap"' },
}));
vi.mock('./runSyncV2.js', () => ({
  syncV2Once: vi.fn(async () => ({ launchesWritten: 0, tradesWritten: 0, transitionsWritten: 0 })),
  syncV2ToReal: vi.fn(async () => ({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 })),
  DEFAULT_ENVIO_V2_TABLES: {
    rawLaunchV2Table: 'envio."RawLaunchV2"', rawCurveTradeTable: 'envio."RawCurveTrade"',
    rawCurveBuybackTable: 'envio."RawCurveBuyback"', rawLifecycleTable: 'envio."RawLifecycleTransition"',
  },
}));
vi.mock('./runSyncV4.js', () => ({
  syncV4Once: vi.fn(async () => ({ venuesOpened: 0, tradesWritten: 0 })),
  syncV4ToReal: vi.fn(async () => ({ venuesOpened: 1, tradesWritten: 1 })),
  DEFAULT_ENVIO_V4_TABLES: { rawV4InitializeTable: 'envio."RawV4Initialize"', rawV4SwapTable: 'envio."RawV4Swap"' },
}));
vi.mock('./envioDb.js', () => ({
  readEnvioProgress: vi.fn(async () => ({ processedBlock: 100n, headBlock: 200n })),
  recordEnvioChainProgress: vi.fn(async () => undefined),
}));
vi.mock('./incrementalSync.js', () => ({
  runTailPass: vi.fn(async () => ({ lane: 'tail', fence: 100n, results: {} })),
  runHistoryPass: vi.fn(async () => ({ lane: 'history', fence: 100n, results: {} })),
  retryUnresolvedEvents: vi.fn(async () => 0),
  syncSourceCoverage: vi.fn(async () => undefined),
}));

const { runAllSyncsOnce, runIncrementalCycle } = await import('./syncAll.js');
const { syncV1LegacyOnce, syncV1LegacyToReal } = await import('./runSync.js');
const { syncV2Once, syncV2ToReal } = await import('./runSyncV2.js');
const { syncV4Once, syncV4ToReal } = await import('./runSyncV4.js');
const { recordEnvioChainProgress } = await import('./envioDb.js');
const { retryUnresolvedEvents, syncSourceCoverage } = await import('./incrementalSync.js');
const { detectEnvioRollback } = await import('./incrementalCursor.js');
const { repairEnvioWindow } = await import('./incrementalRepair.js');

const tables = {
  v1: { rawLaunchTable: 'x', rawSwapTable: 'x' },
  v2: { rawLaunchV2Table: 'x', rawCurveTradeTable: 'x', rawCurveBuybackTable: 'x', rawLifecycleTable: 'x' },
  v4: { rawV4InitializeTable: 'x', rawV4SwapTable: 'x' },
};

describe('runAllSyncsOnce target dispatch', () => {
  it('defaults to the staging-writing variants when target is omitted, and does not mirror chain progress', async () => {
    const result = await runAllSyncsOnce({} as never, {} as never, tables);
    expect(syncV1LegacyOnce).toHaveBeenCalled();
    expect(syncV2Once).toHaveBeenCalled();
    expect(syncV4Once).toHaveBeenCalled();
    expect(syncV1LegacyToReal).not.toHaveBeenCalled();
    expect(recordEnvioChainProgress).not.toHaveBeenCalled();
    expect(result.v1Result).toEqual({ launchesWritten: 0, tradesWritten: 0 });
  });

  it('calls the *ToReal variants and mirrors chain progress when target is "real"', async () => {
    const result = await runAllSyncsOnce({} as never, {} as never, tables, 'real');
    expect(syncV1LegacyToReal).toHaveBeenCalled();
    expect(syncV2ToReal).toHaveBeenCalled();
    expect(syncV4ToReal).toHaveBeenCalled();
    expect(recordEnvioChainProgress).toHaveBeenCalledWith({}, 4663, 200n);
    expect(result.v1Result).toEqual({ launchesWritten: 1, tradesWritten: 1 });
    expect(result.v2Result).toEqual({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 });
    expect(result.v4Result).toEqual({ venuesOpened: 1, tradesWritten: 1 });
  });
});

describe('runIncrementalCycle unresolved-event retry (final review, Critical 1)', () => {
  it('retries unresolved events for every stream every cycle, not only via the integration test\'s direct call', async () => {
    vi.mocked(retryUnresolvedEvents).mockClear();
    await runIncrementalCycle({} as never, {} as never, 4663);
    expect(retryUnresolvedEvents).toHaveBeenCalledTimes(STREAMS.length);
    for (const stream of STREAMS) {
      expect(retryUnresolvedEvents).toHaveBeenCalledWith({}, {}, expect.objectContaining({ chainId: 4663, stream }));
    }
  });
});

describe('runIncrementalCycle source coverage advancement (final review, Critical 3)', () => {
  it('advances per-source coverage watermarks every cycle using the reported Envio head block', async () => {
    vi.mocked(syncSourceCoverage).mockClear();
    await runIncrementalCycle({} as never, {} as never, 4663);
    expect(syncSourceCoverage).toHaveBeenCalledWith({}, 4663, 200n);
  });
});

describe('runIncrementalCycle proactive repair on a detected Envio rollback (final review, Important 8)', () => {
  it('does not repair when no rollback is detected', async () => {
    vi.mocked(detectEnvioRollback).mockResolvedValueOnce(false);
    vi.mocked(repairEnvioWindow).mockClear();
    await runIncrementalCycle({} as never, {} as never, 4663);
    expect(repairEnvioWindow).not.toHaveBeenCalled();
  });

  it('repairs the window immediately on a detected rollback, before resuming normal append ingestion', async () => {
    vi.mocked(detectEnvioRollback).mockResolvedValueOnce(true);
    vi.mocked(repairEnvioWindow).mockClear();
    const { runTailPass } = await import('./incrementalSync.js');
    vi.mocked(runTailPass).mockClear();
    await runIncrementalCycle({} as never, {} as never, 4663);
    expect(detectEnvioRollback).toHaveBeenCalledWith({}, 4663, 100n);
    expect(repairEnvioWindow).toHaveBeenCalledWith({}, {}, expect.objectContaining({ chainId: 4663, fence: 100n }));
    const repairOrder = vi.mocked(repairEnvioWindow).mock.invocationCallOrder[0]!;
    const tailOrder = vi.mocked(runTailPass).mock.invocationCallOrder[0]!;
    expect(repairOrder).toBeLessThan(tailOrder);
  });
});
