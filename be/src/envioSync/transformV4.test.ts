import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { Launch, Venue } from '../domain/types.js';
import { venueKey } from '../domain/ids.js';
import { verifyV4PoolFromEnvio, openV4Venue, type EnvioRawV4InitializeRow } from './transformV4.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const launch: Launch = {
  chainId: 4663, tokenAddress: fixture.tokenAddress as Address, name: null as unknown as string, symbol: null as unknown as string,
  tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: 'l2',
  factoryAddress: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address, deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2' as Address,
  launchBlock: 27823666n, launchTxHash: (fixture.launch as Record<string, unknown>).transactionHash as `0x${string}`,
  quoteAsset: { address: fixture.quoteAddress as Address, symbol: 'NVDA', decimals: 18 }, lifecycleStatus: 'graduated',
};
const curveVenue: Venue = {
  id: venueKey(4663, 'curve', fixture.curveAddress as string), chainId: 4663, tokenAddress: launch.tokenAddress,
  kind: 'curve', ref: fixture.curveAddress as string, sourceId: 'pons-v2', sourceLogId: 'l2',
  effectiveFromBlock: 27823666n, effectiveToBlock: 27823772n, official: true,
};
const graduatedTxHash = '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3';
const graduatedBlockHash = '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e';

function initializeRow(overrides: Partial<EnvioRawV4InitializeRow> = {}): EnvioRawV4InitializeRow {
  return {
    poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
    currency0: fixture.tokenAddress as string,
    currency1: fixture.quoteAddress as string,
    fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    txHash: graduatedTxHash, blockHash: graduatedBlockHash,
    blockNumber: 27828161n, logIndex: 16,
    ...overrides,
  };
}

describe('verifyV4PoolFromEnvio', () => {
  it('accepts the real fixture Initialize event matched to the real graduation tx', () => {
    const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch);
    expect(evidence).not.toBeNull();
    expect(evidence!.poolId).toBe('0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
  });

  it('rejects an Initialize event from a different transaction (same block is not enough)', () => {
    const row = initializeRow({ txHash: '0x' + '7'.repeat(64) });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });

  it('rejects an Initialize event whose currencies do not match the launch', () => {
    const row = initializeRow({ currency1: '0x1111111111111111111111111111111111111111' });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });

  it('rejects an Initialize event using a hook other than the audited Pons hook', () => {
    const row = initializeRow({ hooks: '0x2222222222222222222222222222222222222222' });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });
});

describe('openV4Venue', () => {
  it('opens an official v4_pool venue at the graduation position', () => {
    const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch)!;
    const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: 27828161n, logIndex: 36 });
    expect(venue.kind).toBe('v4_pool');
    expect(venue.ref).toBe('0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
    expect(venue.official).toBe(true);
    expect(venue.effectiveFromBlock).toBe(27828161n);
  });
});
