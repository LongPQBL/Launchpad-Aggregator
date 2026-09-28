import { decodeEventLog, parseAbiItem, toEventSelector, type Address, type Hash } from 'viem';
import type { Launch, Trade, Venue } from '../../../domain/types.js';
import type { RpcLog } from '../v1/adapter.js';

const graduationEvent = parseAbiItem('event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)');
export const v4SwapEvent = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');

export function verifyPonsV4Graduation(log: RpcLog, launch: Launch): boolean {
  if (launch.protocolVersion !== 'v2' || log.address.toLowerCase() !== launch.factoryAddress.toLowerCase()
    || log.topics[0] !== toEventSelector(graduationEvent)) return false;
  const decoded = decodeEventLog({ abi: [graduationEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  return decoded.args.token.toLowerCase() === launch.tokenAddress.toLowerCase();
}

export function decodePonsV4Swap(log: RpcLog, poolId: Hash, launch: Launch, venue: Venue, timestamp: number, poolManager: Address, hook: Address): Trade | null {
  if (log.address.toLowerCase() !== poolManager.toLowerCase() || log.topics[0] !== toEventSelector(v4SwapEvent)
    || log.topics[1]?.toLowerCase() !== poolId.toLowerCase()) return null;
  if (launch.protocolVersion !== 'v2' || launch.lifecycleStatus !== 'graduated' || venue.kind !== 'v4_pool'
    || !venue.official || venue.ref.toLowerCase() !== poolId.toLowerCase() || venue.chainId !== launch.chainId
    || venue.tokenAddress.toLowerCase() !== launch.tokenAddress.toLowerCase()) throw new Error('Not an official graduated pons v2 venue');
  const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
  if (decoded.args.sender.toLowerCase() === hook.toLowerCase()) return null;
  const tokenIsCurrency0 = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase();
  const tokenSigned = tokenIsCurrency0 ? decoded.args.amount0 : decoded.args.amount1;
  const quoteSigned = tokenIsCurrency0 ? decoded.args.amount1 : decoded.args.amount0;
  if (tokenSigned === 0n || quoteSigned === 0n || tokenSigned * quoteSigned >= 0n || decoded.args.sqrtPriceX96 === 0n) {
    throw new Error('Invalid V4 swap amounts or price');
  }
  const q192 = 2n ** 192n;
  const sqrtSquared = decoded.args.sqrtPriceX96 * decoded.args.sqrtPriceX96;
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id, blockNumber: log.blockNumber,
    blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex, timestamp,
    side: quoteSigned > 0n ? 'buy' : 'sell',
    tokenAmountRaw: tokenSigned < 0n ? -tokenSigned : tokenSigned,
    quoteAmountRaw: quoteSigned < 0n ? -quoteSigned : quoteSigned,
    quoteAssetAddress: launch.quoteAsset.address, sourceEvent: 'Swap',
    priceNumeratorRaw: (tokenIsCurrency0 ? sqrtSquared : q192) * 10n ** BigInt(launch.tokenDecimals),
    priceDenominatorRaw: (tokenIsCurrency0 ? q192 : sqrtSquared) * 10n ** BigInt(launch.quoteAsset.decimals),
  };
}
