import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Address, type Hash } from 'viem';
import { getPonsFactorySources } from '../sourceRegistry.js';
import { createRobinhoodPublicClient } from '../../../chains/robinhood.js';
import { decodeV1FactoryBatch, decodeV1Launch, decodeV1Swap, decodeV1SwapBatch, hydrateV1Launch, type RpcLog } from './adapter.js';
import { v3SwapEvent } from './abi.js';
import { readV1Graduation, readV1TokenMetadata, type V1ReadClient } from './state.js';

const sourceFixtures = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-launches.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-v1-reference.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const legacy = getPonsFactorySources()[0];
const active = getPonsFactorySources()[1];
const quote = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;

function asLog(raw: Record<string, unknown>): RpcLog {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number | string),
    blockHash: raw.blockHash as Hash,
    transactionHash: (raw.transactionHash ?? raw.txHash) as Hash,
    logIndex: Number(raw.logIndex),
  };
}

describe('pons v1 launch adapter', () => {
  it('decodes real launch logs from both legacy and active factories', () => {
    const oldEvent = decodeV1Launch(asLog(sourceFixtures[0]), legacy);
    const currentEvent = decodeV1Launch(asLog(sourceFixtures[1]), active);
    expect(oldEvent.tokenAddress).toBe('0xf4eaec43e22251547fbd2cb2f153e041c3aa4ea6');
    expect(currentEvent.tokenAddress).toBe('0x055650555be80649397084cd3f8a09b4350e8612');
    expect(oldEvent.pairToken.toLowerCase()).toBe(quote.toLowerCase());
    expect(currentEvent.poolAddress).toBe('0x8f4f723f10fc7bad28742d25c91158c728557c4c');
  });

  it('rejects a copied token identity without a matching factory log', () => {
    const forged = { ...asLog(sourceFixtures[0]), address: quote };
    expect(() => decodeV1Launch(forged, legacy)).toThrow(/factory/i);
  });

  it('keeps the graduated PONS reference on its original V3 pool', () => {
    const event = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const result = hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, true);
    expect(result.launch.lifecycleStatus).toBe('graduated');
    expect(result.launch.tokenAddress).toBe(reference.tokenAddress);
    expect(result.venue.kind).toBe('v3_pool');
    expect(result.venue.ref).toBe(reference.poolAddress);
    expect(result.venue.effectiveToBlock).toBeNull();
  });

  it('rejects token metadata that disagrees with the factory pool', () => {
    const event = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    expect(() => hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18, liquidityPool: quote,
    }, false)).toThrow(/pool/i);
  });
});

describe('pons v1 V3 trades', () => {
  it('uses the real PONS swap quote leg and post-swap price', () => {
    const event = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, true);
    const trade = decodeV1Swap(asLog(reference.swap as Record<string, unknown>), venue, launch, 1_700_000_000);
    expect(trade.side).toBe('buy');
    expect(trade.quoteAmountRaw).toBe(100_000_000_000_000_000n);
    expect(trade.tokenAmountRaw).toBeGreaterThan(0n);
    expect(trade.priceNumeratorRaw).toBeGreaterThan(0n);
    expect(trade.priceDenominatorRaw).toBeGreaterThan(0n);
  });

  it('uses the opposite signed leg when the launch token is token0', () => {
    const event = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, false);
    launch.tokenAddress = '0x0000000000000000000000000000000000000001';
    venue.tokenAddress = launch.tokenAddress;
    const log: RpcLog = {
      ...asLog(reference.swap as Record<string, unknown>),
      topics: encodeEventTopics({ abi: [v3SwapEvent], eventName: 'Swap', args: { sender: quote, recipient: quote } }) as unknown as Hash[],
      data: encodeAbiParameters(parseAbiParameters('int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick'), [-2n, 5n, 2n ** 96n, 100n, 0]),
    };
    const trade = decodeV1Swap(log, venue, launch, 1_700_000_000);
    expect(trade.side).toBe('buy');
    expect(trade.tokenAmountRaw).toBe(2n);
    expect(trade.quoteAmountRaw).toBe(5n);
    expect(trade.priceNumeratorRaw).toBe(trade.priceDenominatorRaw);
  });

  it('classifies a token1-to-quote swap as a sell', () => {
    const event = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const { launch, venue } = hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18,
      liquidityPool: reference.poolAddress as Address,
    }, false);
    const log: RpcLog = {
      ...asLog(reference.swap as Record<string, unknown>),
      data: encodeAbiParameters(parseAbiParameters('int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick'), [-5n, 2n, 2n ** 96n, 100n, 0]),
    };
    const trade = decodeV1Swap(log, venue, launch, 1_700_000_000);
    expect(trade.side).toBe('sell');
    expect(trade.tokenAmountRaw).toBe(2n);
    expect(trade.quoteAmountRaw).toBe(5n);
  });
});

describe('pons v1 normalized batches', () => {
  it('emits a launch and its official venue with raw-log provenance', async () => {
    const log = asLog(reference.launch as Record<string, unknown>);
    const result = await decodeV1FactoryBatch([log], legacy, async () => ({
      metadata: { name: 'Pons', symbol: 'PONS', decimals: 18, liquidityPool: reference.poolAddress as Address },
      graduated: true,
    }));
    expect(result.launches).toHaveLength(1);
    expect(result.venues).toHaveLength(1);
    expect(result.rawLogs).toHaveLength(1);
    expect(result.launches[0].sourceLogId).toBe(result.venues[0].sourceLogId);
    expect(result.rawLogs[0].sourceId).toBe('pons-v1-legacy');
  });

  it('emits an official pool trade using the pool cohort source', async () => {
    const event = decodeV1Launch(asLog(reference.launch as Record<string, unknown>), legacy);
    const context = hydrateV1Launch(event, legacy, {
      name: 'Pons', symbol: 'PONS', decimals: 18, liquidityPool: reference.poolAddress as Address,
    }, true);
    const result = await decodeV1SwapBatch(
      [asLog(reference.swap as Record<string, unknown>)],
      'pons-v1-pool-cohort-0',
      new Map([[context.venue.ref.toLowerCase(), context]]),
      async () => 1_700_000_000,
    );
    expect(result.trades).toHaveLength(1);
    expect(result.rawLogs).toHaveLength(1);
    expect(result.trades[0].venueId).toBe(context.venue.id);
    expect(result.rawLogs[0].sourceId).toBe('pons-v1-pool-cohort-0');
  });
});

describe('pons v1 graduation state', () => {
  it('accepts the actual Robinhood viem read client', () => {
    const client: V1ReadClient = createRobinhoodPublicClient('https://rpc.mainnet.chain.robinhood.com');
    expect(client.readContract).toBeTypeOf('function');
  });

  it('reads self-describing token metadata and canonical pool', async () => {
    const poolAddress = reference.poolAddress as Address;
    const client = { readContract: async (parameters: { functionName: string }) => {
      switch (parameters.functionName) {
        case 'name': return 'Pons';
        case 'symbol': return 'PONS';
        case 'decimals': return 18;
        case 'liquidityPool': return poolAddress;
        default: throw new Error('unexpected function');
      }
    } };
    const metadata = await readV1TokenMetadata(client, reference.tokenAddress as Address);
    expect(metadata).toEqual({ name: 'Pons', symbol: 'PONS', decimals: 18, liquidityPool: poolAddress });
  });

  it('reads the factory status without deriving graduation from pool balances', async () => {
    const calls: unknown[] = [];
    const client = { readContract: async (parameters: unknown) => { calls.push(parameters); return [5n, 4n, true]; } };
    const graduated = await readV1Graduation(client, reference.tokenAddress as Address, legacy.factory);
    expect(graduated).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
