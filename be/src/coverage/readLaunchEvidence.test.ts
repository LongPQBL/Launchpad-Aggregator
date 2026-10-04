import { describe, expect, it } from 'vitest';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { parseAuditRangeArgs, readLaunchEvidence, validateAuditFence, type LaunchLogFilter } from './readLaunchEvidence.js';

const sources = getPonsFactorySources();
const hash = '0x' + 'a'.repeat(64);
const blockHash = '0x' + 'b'.repeat(64);

describe('bounded launch evidence', () => {
  it.each(sources)('includes both endpoints and exact topic for $id', async (source) => {
    const calls: LaunchLogFilter[] = [];
    const client = { async getLogs(filter: LaunchLogFilter) {
      calls.push(filter);
      return [{ address: source.factory, topics: [source.launchTopic], blockNumber: filter.toBlock,
        blockHash, transactionHash: `0x${filter.toBlock.toString(16).padStart(64, '0')}`, logIndex: 1 }];
    } };
    const events = await readLaunchEvidence(client, source, source.startBlock, source.startBlock + 2n, 2n);
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [source.startBlock, source.startBlock + 1n], [source.startBlock + 2n, source.startBlock + 2n],
    ]);
    expect(calls.every((c) => c.address === source.factory && c.topic === source.launchTopic)).toBe(true);
    expect(events.map((e) => e.blockNumber)).toEqual([source.startBlock + 1n, source.startBlock + 2n]);
  });

  it('rejects a range outside source start or finalized fence', async () => {
    const client = { async getLogs() { return []; } };
    await expect(readLaunchEvidence(client, sources[0]!, sources[0]!.startBlock - 1n, sources[0]!.startBlock, 2n))
      .rejects.toThrow('source start');
    await expect(readLaunchEvidence(client, sources[0]!, sources[0]!.startBlock, sources[0]!.startBlock + 1n, 2n,
      { finalizedFence: sources[0]!.startBlock })).rejects.toThrow('finalized fence');
    await expect(readLaunchEvidence(client, sources[0]!, sources[0]!.startBlock, sources[0]!.startBlock, 2001n))
      .rejects.toThrow('bounded launch range');
  });

  it('deduplicates responses, excludes wrong address/topic, and sorts by block/log', async () => {
    const source = sources[0]!;
    const valid = { address: source.factory, topics: [source.launchTopic], blockNumber: source.startBlock,
      blockHash, transactionHash: hash, logIndex: 2 };
    const client = { async getLogs() { return [valid, valid, { ...valid, logIndex: 1 },
      { ...valid, address: sources[1]!.factory }, { ...valid, topics: [sources[2]!.launchTopic] }]; } };
    const events = await readLaunchEvidence(client, source, source.startBlock, source.startBlock, 1n);
    expect(events.map((e) => e.logIndex)).toEqual([1, 2]);
    expect(events[0]?.blockHash).toBe(blockHash);
  });

  it('backs off once after provider throttling', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const client = { async getLogs() { attempts++; if (attempts === 1) throw new Error('HTTP 429'); return []; } };
    await readLaunchEvidence(client, sources[0]!, sources[0]!.startBlock, sources[0]!.startBlock, 1n,
      { sleep: async (ms) => { delays.push(ms); } });
    expect(attempts).toBe(2);
    expect(delays).toEqual([1000]);
  });

  it('requires a bounded fixed-fence CLI range', () => {
    expect(parseAuditRangeArgs(['--source', 'pons-v1-legacy', '--from', '8600612', '--to', '8600613',
      '--fence', '8600613', '--max-range', '2000'])).toEqual({
      sourceId: 'pons-v1-legacy', fromBlock: 8600612n, toBlock: 8600613n,
      finalizedFence: 8600613n, maxRange: 2000n,
    });
    expect(() => parseAuditRangeArgs(['--source', 'pons-v1-legacy', '--from', '8600612', '--to', '8600614',
      '--fence', '8600613'])).toThrow('finalized fence');
    expect(() => parseAuditRangeArgs(['--source', 'pons-v1-legacy', '--from', '8600612', '--to', '8620612',
      '--fence', '8621112'])).toThrow('20,000');
    expect(() => validateAuditFence(8600612n, 8601112n, 8601111n)).toThrow('observed head');
    expect(() => validateAuditFence(8600613n, 8601112n, 8601112n)).toThrow('provisional');
    expect(() => validateAuditFence(8600612n, 8601112n, 8601112n)).not.toThrow();
  });
});
