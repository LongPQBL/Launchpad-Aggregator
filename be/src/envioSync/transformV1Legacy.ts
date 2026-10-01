import type { Address, Hash } from 'viem';
import { logKey } from '../domain/ids.js';
import type { V1LaunchEvent } from '../launchpads/pons/v1/adapter.js';
import type { Launch, Trade, Venue } from '../domain/types.js';

export interface EnvioRawLaunchRow {
  chainId: number;
  tokenAddress: string;
  deployerAddress: string;
  pairTokenAddress: string;
  poolAddress: string;
  factoryAddress: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export function envioRawLaunchToEvent(row: EnvioRawLaunchRow): V1LaunchEvent {
  return {
    tokenAddress: row.tokenAddress.toLowerCase() as Address,
    deployerAddress: row.deployerAddress.toLowerCase() as Address,
    pairToken: row.pairTokenAddress.toLowerCase() as Address,
    poolAddress: row.poolAddress.toLowerCase() as Address,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash.toLowerCase() as Hash,
    transactionHash: row.txHash.toLowerCase() as Hash,
    logIndex: row.logIndex,
    sourceLogId: logKey(row.chainId, row.blockHash.toLowerCase() as Hash, row.txHash.toLowerCase() as Hash, row.logIndex),
  };
}

export interface EnvioRawSwapRow {
  poolAddress: string;
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

// Mirrors decodeV1Swap's post-decode math exactly (be/src/launchpads/pons/v1/adapter.ts) but takes
// Envio's already-decoded event fields instead of re-decoding a raw log — there is no topics/data to
// decode here, Envio already did that. Kept in lockstep with decodeV1Swap by the cross-check test in
// transformV1Legacy.test.ts, which runs both on the same fixture swap and asserts identical output.
export function hydrateV1SwapFromDecoded(row: EnvioRawSwapRow, venue: Venue, launch: Launch, traderAddress: Address): Trade | null {
  if (venue.kind !== 'v3_pool' || !venue.official || row.poolAddress.toLowerCase() !== venue.ref.toLowerCase()) {
    throw new Error('Swap is not from the official V3 pool');
  }
  if (venue.chainId !== launch.chainId || venue.tokenAddress.toLowerCase() !== launch.tokenAddress.toLowerCase()) {
    throw new Error('Venue does not belong to launch');
  }
  const tokenIsToken0 = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase();
  const tokenSigned = tokenIsToken0 ? row.amount0 : row.amount1;
  const pairSigned = tokenIsToken0 ? row.amount1 : row.amount0;
  if (tokenSigned === 0n || pairSigned === 0n) return null;
  if (tokenSigned * pairSigned > 0n) throw new Error('Invalid V3 swap amounts');
  const q192 = 2n ** 192n;
  const sqrtSquared = row.sqrtPriceX96 * row.sqrtPriceX96;
  if (sqrtSquared === 0n) throw new Error('Invalid V3 sqrt price');
  const decimalScale = 10n ** BigInt(launch.tokenDecimals);
  const quoteScale = 10n ** BigInt(launch.quoteAsset.decimals);
  return {
    chainId: launch.chainId,
    tokenAddress: launch.tokenAddress,
    venueId: venue.id,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash,
    logIndex: row.logIndex,
    timestamp: row.timestamp,
    side: pairSigned > 0n ? 'buy' : 'sell',
    tokenAmountRaw: tokenSigned < 0n ? -tokenSigned : tokenSigned,
    quoteAmountRaw: pairSigned < 0n ? -pairSigned : pairSigned,
    quoteAssetAddress: launch.quoteAsset.address,
    sourceEvent: 'Swap',
    activityKind: 'user_trade',
    priceNumeratorRaw: tokenIsToken0 ? sqrtSquared * decimalScale : q192 * decimalScale,
    priceDenominatorRaw: tokenIsToken0 ? q192 * quoteScale : sqrtSquared * quoteScale,
    traderAddress: traderAddress.toLowerCase() as Address,
  };
}
