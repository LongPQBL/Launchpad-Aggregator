import { describe, expect, it, vi } from 'vitest';

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

const { runAllSyncsOnce } = await import('./syncAll.js');
const { syncV1LegacyOnce, syncV1LegacyToReal } = await import('./runSync.js');
const { syncV2Once, syncV2ToReal } = await import('./runSyncV2.js');
const { syncV4Once, syncV4ToReal } = await import('./runSyncV4.js');
const { recordEnvioChainProgress } = await import('./envioDb.js');

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
