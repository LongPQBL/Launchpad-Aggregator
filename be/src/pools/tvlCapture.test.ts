import { describe, expect, it } from 'vitest';
import { parseSnapshotConfig } from './tvlCapture.js';

describe('parseSnapshotConfig', () => {
  it('defaults to hourly capture and 7 days of retention', () => {
    expect(parseSnapshotConfig({})).toEqual({ intervalSeconds: 3600, retentionHours: 168 });
  });
  it('refuses a retention shorter than 26h, which could delete the row the 24h comparison needs', () => {
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_RETENTION_HOURS: '25' })).toThrow(/>= 26/);
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_RETENTION_HOURS: 'abc' })).toThrow(/>= 26/);
    expect(parseSnapshotConfig({ POOL_TVL_SNAPSHOT_RETENTION_HOURS: '26' }).retentionHours).toBe(26);
  });
  it('refuses an interval outside 60-14400s so a snapshot always falls inside the +-2h window', () => {
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_INTERVAL_SECONDS: '30' })).toThrow(/60/);
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_INTERVAL_SECONDS: '20000' })).toThrow(/14400/);
    expect(() => parseSnapshotConfig({ POOL_TVL_SNAPSHOT_INTERVAL_SECONDS: '1.5' })).toThrow();
  });
});
