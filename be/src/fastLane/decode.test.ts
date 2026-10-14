import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent } from '../launchpads/pons/v2/abi.js';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import { classifyLog, decodeLiveLog, FAST_LANE_EVENTS, type FastLog } from './decode.js';

const curve = '0xAbCdEf0000000000000000000000000000000001';
const trader = '0x1111111111111111111111111111111111111111';
const blockHash = `0x${'b1'.repeat(32)}`;
const txHash = `0x${'a1'.repeat(32)}`;
const poolId: Hex = `0x${'cd'.repeat(32)}`;
const context = { chainId: 4663, timestamp: 1_700_000_123, txFrom: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa' };

function log(address: string, topics: readonly (string | readonly string[] | null)[], data: string, logIndex = 7): FastLog {
  return { address, topics: topics as readonly string[], data, blockNumber: 1234n, blockHash, transactionHash: txHash, logIndex };
}
function curveBuyLog() {
  const topics = encodeEventTopics({ abi: [curveBuyEvent], eventName: 'CurveBuy', args: { buyer: trader, recipient: trader } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [2000n, 1000n, 20n, 5n]);
  return log(curve, topics, data);
}
function curveSellLog() {
  const topics = encodeEventTopics({ abi: [curveSellEvent], eventName: 'CurveSell', args: { seller: trader, recipient: trader } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1000n, 1900n, 19n, 4n]);
  return log(curve, topics, data);
}
function buybackLog() {
  const topics = encodeEventTopics({ abi: [curveBuybackEvent], eventName: 'BuybackLocked' });
  return log(curve, topics, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [700n, 500n]));
}
function v3Log() {
  const topics = encodeEventTopics({ abi: [v3SwapEvent], eventName: 'Swap', args: { sender: trader, recipient: trader } });
  const data = encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [100n, -200n, 79228162514264337593543950336n, 5n, -12]);
  return log('0x2000000000000000000000000000000000000AbC', topics, data);
}
function v4Log() {
  const topics = encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: poolId, sender: trader } });
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [-300n, 600n, 79228162514264337593543950336n, 9n, 4, 3000]);
  return log('0x8366a39cC670b4001a1121b8f6A443A643E40951', topics, data);
}

describe('classifyLog', () => {
  it('names the stream and the venue a log must belong to, from its topics only', () => {
    expect(classifyLog(curveBuyLog())).toEqual({ event: 'CurveBuy', stream: 'v2-curve', watchKind: 'curve', watchRef: curve.toLowerCase() });
    expect(classifyLog(curveSellLog())).toMatchObject({ event: 'CurveSell', stream: 'v2-curve', watchKind: 'curve' });
    expect(classifyLog(buybackLog())).toMatchObject({ event: 'BuybackLocked', stream: 'v2-buyback', watchKind: 'curve' });
    expect(classifyLog(v3Log())).toEqual({ event: 'V3Swap', stream: 'v1-swap', watchKind: 'v3_pool', watchRef: '0x2000000000000000000000000000000000000abc' });
    expect(classifyLog(v4Log())).toEqual({ event: 'V4Swap', stream: 'v4-swap', watchKind: 'v4_pool', watchRef: poolId });
  });
  it('ignores a log of any other event, and a V4 swap without its pool id topic', () => {
    expect(classifyLog({ address: curve, topics: [`0x${'00'.repeat(32)}`] })).toBeNull();
    expect(classifyLog({ address: curve, topics: [] })).toBeNull();
    expect(classifyLog({ address: curve, topics: [v4Log().topics[0]!] })).toBeNull();
  });
  it('subscribes to exactly the five events', () => {
    expect(FAST_LANE_EVENTS).toHaveLength(5);
  });
});

describe('decodeLiveLog builds the raw row Envio writes for the same event', () => {
  const id = `4663-${blockHash}-${txHash}-7`;
  const position = { txFrom: context.txFrom.toLowerCase(), blockNumber: '1234', blockHash, txHash, logIndex: 7, timestamp: 1_700_000_123 };

  it('CurveBuy: tokens out and quote in, with fee and tax', () => {
    expect(decodeLiveLog(curveBuyLog(), context)).toEqual({ stream: 'v2-curve', raw: {
      id, chainId: 4663, curveAddress: curve.toLowerCase(), side: 'buy', tokenAmountRaw: '1000', quoteAmountRaw: '2000', feeRaw: '20', taxRaw: '5', ...position } });
  });
  it('CurveSell: tokens in and quote out', () => {
    expect(decodeLiveLog(curveSellLog(), context)).toEqual({ stream: 'v2-curve', raw: {
      id, chainId: 4663, curveAddress: curve.toLowerCase(), side: 'sell', tokenAmountRaw: '1000', quoteAmountRaw: '1900', feeRaw: '19', taxRaw: '4', ...position } });
  });
  it('BuybackLocked', () => {
    expect(decodeLiveLog(buybackLog(), context)).toEqual({ stream: 'v2-buyback', raw: {
      id, chainId: 4663, curveAddress: curve.toLowerCase(), quoteSpentRaw: '700', tokensLockedRaw: '500', ...position } });
  });
  it('V3 swap', () => {
    expect(decodeLiveLog(v3Log(), context)).toEqual({ stream: 'v1-swap', raw: {
      id, chainId: 4663, poolAddress: '0x2000000000000000000000000000000000000abc', amount0: '100', amount1: '-200',
      sqrtPriceX96: '79228162514264337593543950336', ...position } });
  });
  it('V4 swap: pool id and sender, liquidity and tick left at their unused placeholders, fee as a number', () => {
    expect(decodeLiveLog(v4Log(), context)).toEqual({ stream: 'v4-swap', raw: {
      id, chainId: 4663, poolId, sender: trader, amount0: '-300', amount1: '600', sqrtPriceX96: '79228162514264337593543950336',
      liquidity: '0', tick: 0, fee: 3000, ...position } });
  });
  it('returns null for malformed data or an unknown event instead of throwing', () => {
    expect(decodeLiveLog({ ...curveBuyLog(), data: '0x1234' }, context)).toBeNull();
    expect(decodeLiveLog({ ...curveBuyLog(), topics: [`0x${'00'.repeat(32)}`] }, context)).toBeNull();
  });
});
