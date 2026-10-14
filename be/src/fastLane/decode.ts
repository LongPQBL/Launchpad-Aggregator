import { decodeEventLog, toEventSelector, type Hex } from 'viem';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent } from '../launchpads/pons/v2/abi.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import { v4PoolManager, type LiveEntry, type LiveStream } from '../envioSync/incrementalSync.js';

export interface FastLog {
  address: string; topics: readonly string[]; data: string;
  blockNumber: bigint; blockHash: string; transactionHash: string; logIndex: number; removed?: boolean;
}
export type WatchKind = 'curve' | 'v3_pool' | 'v4_pool';
export type LiveEventName = 'CurveBuy' | 'CurveSell' | 'BuybackLocked' | 'V3Swap' | 'V4Swap';
export interface LogClass { event: LiveEventName; stream: LiveStream; watchKind: WatchKind; watchRef: string }

/** Every event the lane listens to. The order is not significant. */
export const FAST_LANE_EVENTS = [curveBuyEvent, curveSellEvent, curveBuybackEvent, v3SwapEvent, v4SwapEvent] as const;

const EVENT_BY_SELECTOR = new Map<string, LiveEventName>([
  [toEventSelector(curveBuyEvent), 'CurveBuy'], [toEventSelector(curveSellEvent), 'CurveSell'], [toEventSelector(curveBuybackEvent), 'BuybackLocked'],
  [toEventSelector(v3SwapEvent), 'V3Swap'], [toEventSelector(v4SwapEvent), 'V4Swap'],
]);

const V4_POOL_MANAGER = v4PoolManager.toLowerCase();

/**
 * What a log is and which known venue it would have to belong to — from its address and topics alone, so a cheap filter can run before any
 * RPC call. A V4 swap names its pool only in a topic, so it is accepted only from the PoolManager: any contract can emit the same event.
 */
export function classifyLog(log: Pick<FastLog, 'address' | 'topics'>): LogClass | null {
  const event = EVENT_BY_SELECTOR.get(log.topics[0]?.toLowerCase() ?? '');
  if (!event) return null;
  const address = log.address.toLowerCase();
  switch (event) {
    case 'CurveBuy': case 'CurveSell': return { event, stream: 'v2-curve', watchKind: 'curve', watchRef: address };
    case 'BuybackLocked': return { event, stream: 'v2-buyback', watchKind: 'curve', watchRef: address };
    case 'V3Swap': return { event, stream: 'v1-swap', watchKind: 'v3_pool', watchRef: address };
    case 'V4Swap': {
      if (address !== V4_POOL_MANAGER) return null;
      const poolId = log.topics[1];
      return poolId ? { event, stream: 'v4-swap', watchKind: 'v4_pool', watchRef: poolId.toLowerCase() } : null;
    }
  }
}

/**
 * Builds the raw row `envio/src/EventHandlers.ts` writes for the same event, so `applyLiveRows` hydrates it exactly like an Envio row.
 * Amounts are decimal strings. Returns null (never throws) for an unknown event or data that does not decode.
 */
export function decodeLiveLog(log: FastLog, context: { chainId: number; timestamp: number; txFrom: string }): LiveEntry | null {
  const cls = classifyLog(log);
  if (!cls) return null;
  const topics = log.topics as [Hex, ...Hex[]];
  const data = log.data as Hex;
  const position = {
    id: `${context.chainId}-${log.blockHash}-${log.transactionHash}-${log.logIndex}`, chainId: context.chainId,
  };
  const where = {
    txFrom: context.txFrom.toLowerCase(), blockNumber: log.blockNumber.toString(), blockHash: log.blockHash,
    txHash: log.transactionHash, logIndex: log.logIndex, timestamp: context.timestamp,
  };
  const s = (value: bigint | number) => value.toString();
  try {
    switch (cls.event) {
      case 'CurveBuy': {
        const { args } = decodeEventLog({ abi: [curveBuyEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, curveAddress: cls.watchRef, side: 'buy', tokenAmountRaw: s(args.tokensOut),
          quoteAmountRaw: s(args.quoteIn), feeRaw: s(args.fee), taxRaw: s(args.tax), ...where } };
      }
      case 'CurveSell': {
        const { args } = decodeEventLog({ abi: [curveSellEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, curveAddress: cls.watchRef, side: 'sell', tokenAmountRaw: s(args.tokensIn),
          quoteAmountRaw: s(args.quoteOut), feeRaw: s(args.fee), taxRaw: s(args.tax), ...where } };
      }
      case 'BuybackLocked': {
        const { args } = decodeEventLog({ abi: [curveBuybackEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, curveAddress: cls.watchRef, quoteSpentRaw: s(args.quoteSpent),
          tokensLockedRaw: s(args.tokensLocked), ...where } };
      }
      case 'V3Swap': {
        const { args } = decodeEventLog({ abi: [v3SwapEvent], data, topics, strict: true });
        return { stream: cls.stream, raw: { ...position, poolAddress: cls.watchRef, amount0: s(args.amount0), amount1: s(args.amount1),
          sqrtPriceX96: s(args.sqrtPriceX96), ...where } };
      }
      case 'V4Swap': {
        const { args } = decodeEventLog({ abi: [v4SwapEvent], data, topics, strict: true });
        // liquidity and tick are stored by Envio as unused placeholders (see its V4Swap handler); fee is a number there.
        return { stream: cls.stream, raw: { ...position, poolId: cls.watchRef, sender: args.sender.toLowerCase(), amount0: s(args.amount0),
          amount1: s(args.amount1), sqrtPriceX96: s(args.sqrtPriceX96), liquidity: '0', tick: 0, fee: Number(args.fee), ...where } };
      }
    }
  } catch {
    return null;
  }
}
