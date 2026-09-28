import { decodeEventLog, encodeAbiParameters, keccak256, parseAbiItem, toEventSelector, type Address, type Hash } from 'viem';
import { venueKey } from '../../../domain/ids.js';
import type { Launch, Venue } from '../../../domain/types.js';
import type { RpcLog } from '../v1/adapter.js';

export interface V4PoolTerms { fee: number; tickSpacing: number }
export interface VenueTransition { closedCurve: Venue | null; openedPool: Venue | null }

const initializeEvent = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');

function currencies(launch: Launch): [Address, Address] {
  const token = launch.tokenAddress;
  const quote = launch.quoteAsset.address;
  if (token.toLowerCase() === quote.toLowerCase()) throw new Error('V4 pool currencies must differ');
  return token.toLowerCase() < quote.toLowerCase() ? [token, quote] : [quote, token];
}

export function derivePonsV4PoolId(launch: Launch, terms: V4PoolTerms, hook: Address): Hash {
  if (launch.protocolVersion !== 'v2' || terms.fee !== 0 || !Number.isInteger(terms.tickSpacing) || terms.tickSpacing <= 0) {
    throw new Error('Invalid pons v2 V4 pool terms');
  }
  const [currency0, currency1] = currencies(launch);
  return keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
  ], [currency0, currency1, terms.fee, terms.tickSpacing, hook]));
}

export function verifyPonsV4PoolInitialization(log: RpcLog, graduation: RpcLog, launch: Launch,
  terms: V4PoolTerms, hook: Address, poolManager: Address): boolean {
  if (log.address.toLowerCase() !== poolManager.toLowerCase() || log.topics[0] !== toEventSelector(initializeEvent)
    || graduation.transactionHash.toLowerCase() !== log.transactionHash.toLowerCase() || graduation.blockHash.toLowerCase() !== log.blockHash.toLowerCase()) return false;
  const decoded = decodeEventLog({ abi: [initializeEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  const [currency0, currency1] = currencies(launch);
  return decoded.args.id.toLowerCase() === derivePonsV4PoolId(launch, terms, hook).toLowerCase()
    && decoded.args.currency0.toLowerCase() === currency0.toLowerCase()
    && decoded.args.currency1.toLowerCase() === currency1.toLowerCase()
    && decoded.args.fee === terms.fee && decoded.args.tickSpacing === terms.tickSpacing
    && decoded.args.hooks.toLowerCase() === hook.toLowerCase();
}

export function transitionOfficialVenue(launch: Launch, curveVenue: Venue, phase: 0 | 1 | 2 | 3,
  block: bigint, poolId?: Hash, sourceLogId?: string): VenueTransition {
  if (launch.protocolVersion !== 'v2' || curveVenue.kind !== 'curve' || curveVenue.chainId !== launch.chainId
    || curveVenue.tokenAddress.toLowerCase() !== launch.tokenAddress.toLowerCase()) throw new Error('Invalid pons v2 curve venue');
  if (phase === 0) return { closedCurve: null, openedPool: null };
  if (block < curveVenue.effectiveFromBlock) throw new Error('Venue transition precedes launch');
  const closedCurve = { ...curveVenue, effectiveToBlock: block };
  if (phase !== 2) return { closedCurve, openedPool: null };
  if (!poolId || !sourceLogId) throw new Error('Graduated venue requires verified pool and source log');
  const openedPool: Venue = {
    id: venueKey(launch.chainId, 'v4_pool', poolId), chainId: launch.chainId, tokenAddress: launch.tokenAddress,
    kind: 'v4_pool', ref: poolId, sourceId: launch.sourceId, sourceLogId, effectiveFromBlock: block,
    effectiveToBlock: null, official: true,
  };
  return { closedCurve, openedPool };
}
