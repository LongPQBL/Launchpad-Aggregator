import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { decodeV1Launch, hydrateV1Launch, type RpcLog } from '../launchpads/pons/v1/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { decodeV1Swap } from '../launchpads/pons/v1/adapter.js';
import { envioRawLaunchToEvent, hydrateV1SwapFromDecoded, type EnvioRawLaunchRow, type EnvioRawSwapRow } from './transformV1Legacy.js';

const reference = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v1-reference.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const legacy = getPonsFactorySources()[0];

function asLog(raw: Record<string, unknown>): RpcLog {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as string),
    blockHash: raw.blockHash as Hash,
    transactionHash: (raw.transactionHash ?? raw.txHash) as Hash,
    logIndex: Number(raw.logIndex),
  };
}

describe('envioRawLaunchToEvent', () => {
  it('produces the same V1LaunchEvent as decoding the raw log directly', () => {
    const expected = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const row: EnvioRawLaunchRow = {
      chainId: 4663,
      tokenAddress: reference.tokenAddress as string,
      deployerAddress: '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
      pairTokenAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      poolAddress: reference.poolAddress as string,
      factoryAddress: legacy.factory,
      blockNumber: 8963150n,
      blockHash: (reference.launch as Record<string, unknown>).blockHash as string,
      txHash: '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8',
      logIndex: 45,
    };
    const event = envioRawLaunchToEvent(row);
    expect(event).toEqual(expected);
  });
});

const trader = '0x1234567890123456789012345678901234567890' as Address;

describe('hydrateV1SwapFromDecoded', () => {
  it('produces the same Trade as decoding the raw swap log directly', () => {
    const launchEvent = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(launchEvent, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, true);
    const expected = decodeV1Swap(asLog(reference.swap as Record<string, unknown>), venue, launch, 1_700_000_000, trader);
    const row: EnvioRawSwapRow = {
      poolAddress: reference.poolAddress as string,
      sender: '0xcaf681a66d020601342297493863e78c959e5cb2',
      recipient: '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a',
      amount0: 100_000_000_000_000_000n,
      amount1: -68057245261861571047346184n,
      sqrtPriceX96: 2005366647941715384651103712059394n,
      liquidity: 36819258015569838458222n,
      tick: 202790,
      blockNumber: 8963150n,
      blockHash: (reference.swap as Record<string, unknown>).blockHash as string,
      txHash: '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8',
      logIndex: 49,
      timestamp: 1_700_000_000,
    };
    const trade = hydrateV1SwapFromDecoded(row, venue, launch, trader);
    expect(trade).toEqual(expected);
    expect(trade!.side).toBe('buy');
    expect(trade!.quoteAmountRaw).toBe(100_000_000_000_000_000n);
  });

  it('nulls a dust swap where one leg is exactly zero, matching decodeV1Swap', () => {
    const launchEvent = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(launchEvent, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, true);
    const row: EnvioRawSwapRow = {
      poolAddress: reference.poolAddress as string,
      sender: '0xcaf681a66d020601342297493863e78c959e5cb2',
      recipient: '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a',
      amount0: 0n,
      amount1: 25654359n,
      // sqrtPriceX96/liquidity/tick are irrelevant here: hydrateV1SwapFromDecoded returns null as
      // soon as it sees a zero leg, before these fields are ever read.
      sqrtPriceX96: 2005366647941715384651103712059394n,
      liquidity: 36819258015569838458222n,
      tick: 202790,
      blockNumber: 9265305n,
      blockHash: '0x' + '9'.repeat(64),
      txHash: '0xba1e0cde96648343c22aea642b45fccbd4a8d3fdcea940fdc770ad5835b4348f',
      logIndex: 1,
      timestamp: 1_700_000_000,
    };
    expect(hydrateV1SwapFromDecoded(row, venue, launch, trader)).toBeNull();
  });
});

describe('hydrateV1Launch via envioRawLaunchToEvent', () => {
  it('still rejects a non-WETH pair, exactly like the direct decode path', () => {
    const row: EnvioRawLaunchRow = {
      chainId: 4663,
      tokenAddress: reference.tokenAddress as string,
      deployerAddress: '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
      pairTokenAddress: '0x1111111111111111111111111111111111111111',
      poolAddress: reference.poolAddress as string,
      factoryAddress: legacy.factory,
      blockNumber: 8963150n,
      blockHash: (reference.launch as Record<string, unknown>).blockHash as string,
      txHash: '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8',
      logIndex: 45,
    };
    const event = envioRawLaunchToEvent(row);
    expect(() => hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18, liquidityPool: reference.poolAddress as Address,
    }, true)).toThrow(/quote asset/);
  });
});
