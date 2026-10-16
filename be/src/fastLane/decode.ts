import { decodeEventLog, parseAbiItem, toEventSelector, type Hex } from 'viem';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { curveBuyEvent, curveBuybackEvent, curveSellEvent, launchGraduationRescuedEvent, launchSweptEvent, poolGraduatedEvent } from '../launchpads/pons/v2/abi.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import { v4PoolManager, type LiveEntry, type LiveStream } from '../envioSync/incrementalSync.js';

export interface FastLog {
  address: string; topics: readonly string[]; data: string;
  blockNumber: bigint; blockHash: string; transactionHash: string; logIndex: number; removed?: boolean;
}
export type WatchKind = 'curve' | 'v2_pool' | 'v3_pool' | 'v4_pool' | 'lifecycle_factory';
export type LiveEventName = 'CurveBuy' | 'CurveSell' | 'BuybackLocked' | 'V3Swap' | 'V4Swap' |
  'V4ModifyLiquidity' | 'V3Mint' | 'V3Burn' | 'V2Mint' | 'V2Burn' | 'V2Sync' | 'V2Swap' |
  'LaunchSwept' | 'PoolGraduated' | 'LaunchGraduationRescued';
export interface LogClass { event: LiveEventName; stream: LiveStream | null; watchKind: WatchKind; watchRef: string }

export const v4ModifyLiquidityEvent = parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)');
export const v3MintEvent = parseAbiItem('event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)');
export const v3BurnEvent = parseAbiItem('event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)');
export const v2MintEvent = parseAbiItem('event Mint(address indexed sender, uint256 amount0, uint256 amount1)');
export const v2BurnEvent = parseAbiItem('event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)');
export const v2SyncEvent = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');
export const v2SwapEvent = parseAbiItem('event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)');

/** Every event the lane listens to. The order is not significant. */
export const FAST_LANE_EVENTS = [curveBuyEvent, curveSellEvent, curveBuybackEvent, v3SwapEvent, v4SwapEvent,
  v4ModifyLiquidityEvent, v3MintEvent, v3BurnEvent, v2MintEvent, v2BurnEvent, v2SyncEvent, v2SwapEvent,
  launchSweptEvent, poolGraduatedEvent, launchGraduationRescuedEvent] as const;

const EVENT_BY_SELECTOR = new Map<string, LiveEventName>([
  [toEventSelector(curveBuyEvent), 'CurveBuy'], [toEventSelector(curveSellEvent), 'CurveSell'], [toEventSelector(curveBuybackEvent), 'BuybackLocked'],
  [toEventSelector(v3SwapEvent), 'V3Swap'], [toEventSelector(v4SwapEvent), 'V4Swap'],
  [toEventSelector(v4ModifyLiquidityEvent), 'V4ModifyLiquidity'], [toEventSelector(v3MintEvent), 'V3Mint'],
  [toEventSelector(v3BurnEvent), 'V3Burn'], [toEventSelector(v2MintEvent), 'V2Mint'],
  [toEventSelector(v2BurnEvent), 'V2Burn'], [toEventSelector(v2SyncEvent), 'V2Sync'], [toEventSelector(v2SwapEvent), 'V2Swap'],
  [toEventSelector(launchSweptEvent), 'LaunchSwept'], [toEventSelector(poolGraduatedEvent), 'PoolGraduated'],
  [toEventSelector(launchGraduationRescuedEvent), 'LaunchGraduationRescued'],
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
    case 'V3Mint': case 'V3Burn': return { event, stream: null, watchKind: 'v3_pool', watchRef: address };
    case 'V2Mint': case 'V2Burn': case 'V2Sync': case 'V2Swap': return { event, stream: null, watchKind: 'v2_pool', watchRef: address };
    case 'LaunchSwept': case 'PoolGraduated': case 'LaunchGraduationRescued':
      return log.topics[1] ? { event, stream: null, watchKind: 'lifecycle_factory', watchRef: address } : null;
    case 'V4Swap': case 'V4ModifyLiquidity': {
      if (address !== V4_POOL_MANAGER) return null;
      const poolId = log.topics[1];
      return poolId ? { event, stream: event === 'V4Swap' ? 'v4-swap' : null, watchKind: 'v4_pool', watchRef: poolId.toLowerCase() } : null;
    }
  }
}

export function lifecycleToken(log: FastLog): string | null {
  const cls = classifyLog(log);
  if (cls?.watchKind !== 'lifecycle_factory' || !log.topics[1] || log.topics[1].length !== 66) return null;
  return `0x${log.topics[1].slice(-40)}`.toLowerCase();
}

export function decodeV2Sync(log: FastLog): { reserve0: bigint; reserve1: bigint } | null {
  try {
    const { args } = decodeEventLog({ abi: [v2SyncEvent], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
    return { reserve0: args.reserve0, reserve1: args.reserve1 };
  } catch { return null; }
}

export interface V2PoolEntry { stream: 'v2-pool-swap'; raw: Record<string, unknown> }
export function decodeV2PoolSwap(log: FastLog, context: { chainId: number; timestamp: number; txFrom: string; sqrtPriceX96: bigint }): V2PoolEntry | null {
  if (classifyLog(log)?.event !== 'V2Swap') return null;
  try {
    const { args } = decodeEventLog({ abi: [v2SwapEvent], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
    return { stream: 'v2-pool-swap', raw: {
      id: `${context.chainId}-${log.blockHash}-${log.transactionHash}-${log.logIndex}`, chainId: context.chainId,
      pairAddress: log.address.toLowerCase(), sender: args.sender.toLowerCase(),
      amount0In: args.amount0In.toString(), amount1In: args.amount1In.toString(),
      amount0Out: args.amount0Out.toString(), amount1Out: args.amount1Out.toString(),
      sqrtPriceX96: context.sqrtPriceX96.toString(), txFrom: context.txFrom.toLowerCase(),
      blockNumber: log.blockNumber.toString(), blockHash: log.blockHash, txHash: log.transactionHash,
      logIndex: log.logIndex, timestamp: context.timestamp,
    } };
  } catch { return null; }
}

/**
 * Builds the raw row `envio/src/EventHandlers.ts` writes for the same event, so `applyLiveRows` hydrates it exactly like an Envio row.
 * Amounts are decimal strings. Returns null (never throws) for an unknown event or data that does not decode.
 */
export function decodeLiveLog(log: FastLog, context: { chainId: number; timestamp: number; txFrom: string }): LiveEntry | null {
  const cls = classifyLog(log);
  if (!cls || !cls.stream) return null;
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
          sqrtPriceX96: s(args.sqrtPriceX96), sender: args.sender.toLowerCase(), ...where } };
      }
      case 'V4Swap': {
        const { args } = decodeEventLog({ abi: [v4SwapEvent], data, topics, strict: true });
        // liquidity and tick are stored by Envio as unused placeholders (see its V4Swap handler); fee is a number there.
        return { stream: cls.stream, raw: { ...position, poolId: cls.watchRef, sender: args.sender.toLowerCase(), amount0: s(args.amount0),
          amount1: s(args.amount1), sqrtPriceX96: s(args.sqrtPriceX96), liquidity: '0', tick: 0, fee: Number(args.fee), ...where } };
      }
      default: return null;
    }
  } catch {
    return null;
  }
}
