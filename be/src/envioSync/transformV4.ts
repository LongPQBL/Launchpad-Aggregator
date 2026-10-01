import type { Address, Hash } from 'viem';
import { derivePonsV4PoolId, transitionOfficialVenue, type GraduatedPoolEvidence, type V4PoolTerms } from '../launchpads/pons/v2/poolKey.js';
import type { Launch, Trade, Venue } from '../domain/types.js';

const PONS_HOOK: Address = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';

export interface EnvioRawV4InitializeRow {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

// Unlike the RPC-scan path (which independently knows the launch's v4PoolFee/v4TickSpacing from a
// factory-state RPC read made at launch time, and checks the Initialize event against those
// pre-known values), this phase's sync layer has no RPC access — so it reads fee/tickSpacing directly
// from the candidate Initialize event itself, then re-derives the expected pool ID from those values
// plus the launch's real currencies plus the hardcoded Pons hook, and confirms it equals the event's
// own claimed id. This is not weaker: derivePonsV4PoolId's hash already binds fee+tickSpacing+hooks+
// currencies together, so a mismatched currency or hook still fails even though fee/tickSpacing come
// from the event under test — confirmed empirically during planning (derivePonsV4PoolId reproduces
// the fixture's real, on-chain pool ID exactly from these exact fields).
export function verifyV4PoolFromEnvio(
  row: EnvioRawV4InitializeRow,
  graduatedTxHash: string,
  graduatedBlockHash: string,
  launch: Launch,
): GraduatedPoolEvidence | null {
  if (row.txHash.toLowerCase() !== graduatedTxHash.toLowerCase() || row.blockHash.toLowerCase() !== graduatedBlockHash.toLowerCase()) {
    return null;
  }
  if (row.hooks.toLowerCase() !== PONS_HOOK.toLowerCase()) return null;
  const terms: V4PoolTerms = { fee: row.fee, tickSpacing: row.tickSpacing };
  let expectedId: Hash;
  try {
    expectedId = derivePonsV4PoolId(launch, terms, PONS_HOOK);
  } catch {
    return null;
  }
  if (expectedId.toLowerCase() !== row.poolId.toLowerCase()) return null;
  const [expectedCurrency0, expectedCurrency1] = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase()
    ? [launch.tokenAddress, launch.quoteAsset.address] : [launch.quoteAsset.address, launch.tokenAddress];
  if (row.currency0.toLowerCase() !== expectedCurrency0.toLowerCase() || row.currency1.toLowerCase() !== expectedCurrency1.toLowerCase()) {
    return null;
  }
  return { poolId: row.poolId.toLowerCase() as Hash, sourceLogId: `v4-init-${row.txHash.toLowerCase()}-${row.logIndex}`,
    sourceId: `pons-v2-v4:${row.poolId.toLowerCase()}` };
}

export function openV4Venue(launch: Launch, curveVenue: Venue, evidence: GraduatedPoolEvidence, position: { blockNumber: bigint; logIndex: number }): Venue {
  const transition = transitionOfficialVenue(launch, curveVenue, 2, position, evidence);
  if (!transition.openedPool) throw new Error('Expected an opened V4 pool venue');
  return transition.openedPool;
}

export interface EnvioRawV4SwapRow {
  poolId: string;
  sender: string;
  txFrom: string;
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

// Mirrors decodePonsV4Swap's output exactly (be/src/launchpads/pons/v2/v4Swaps.ts) but Envio already
// decoded the event, so there is no raw log to re-decode — same pattern as Phase 2's curve trade
// transform. `sender` classifies protocol-vs-user activity (hook-initiated); `txFrom` (tx.from, not
// `sender`) is the real trader.
// quoteAssetDecimals is the raw nullable staging column (be/src/db/schema.ts), not launch.quoteAsset's
// always-numeric field — this phase's sync layer has no RPC access to a real ERC20's decimals, so
// unlike the RPC-scan path (which always knows them), price must be left null rather than computed
// from a faked value, matching transformV2.ts's resolveKnownQuoteAsset discipline for curve trades.
export function hydrateV4SwapFromDecoded(row: EnvioRawV4SwapRow, venue: Venue, launch: Launch, quoteAssetDecimals: number | null): Trade | null {
  if (venue.kind !== 'v4_pool' || !venue.official || row.poolId.toLowerCase() !== venue.ref.toLowerCase()) {
    throw new Error('Swap is not from the official V4 pool');
  }
  const protocolSwap = row.sender.toLowerCase() === PONS_HOOK.toLowerCase();
  const tokenIsCurrency0 = launch.tokenAddress.toLowerCase() < launch.quoteAsset.address.toLowerCase();
  const tokenSigned = tokenIsCurrency0 ? row.amount0 : row.amount1;
  const quoteSigned = tokenIsCurrency0 ? row.amount1 : row.amount0;
  if (tokenSigned === 0n || quoteSigned === 0n) return null;
  if (tokenSigned * quoteSigned >= 0n || row.sqrtPriceX96 === 0n) throw new Error('Invalid V4 swap amounts or price');
  const q192 = 2n ** 192n;
  const sqrtSquared = row.sqrtPriceX96 * row.sqrtPriceX96;
  return {
    chainId: launch.chainId, tokenAddress: launch.tokenAddress, venueId: venue.id,
    blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase() as Hash,
    txHash: row.txHash.toLowerCase() as Hash, logIndex: row.logIndex, timestamp: row.timestamp,
    side: quoteSigned < 0n ? 'buy' : 'sell',
    tokenAmountRaw: tokenSigned < 0n ? -tokenSigned : tokenSigned,
    quoteAmountRaw: quoteSigned < 0n ? -quoteSigned : quoteSigned,
    quoteAssetAddress: launch.quoteAsset.address, sourceEvent: 'Swap',
    activityKind: protocolSwap ? (quoteSigned < 0n ? 'protocol_buyback' : 'protocol_fee_conversion') : 'user_trade',
    priceNumeratorRaw: quoteAssetDecimals === null ? null : (tokenIsCurrency0 ? sqrtSquared : q192) * 10n ** BigInt(launch.tokenDecimals),
    priceDenominatorRaw: quoteAssetDecimals === null ? null : (tokenIsCurrency0 ? q192 : sqrtSquared) * 10n ** BigInt(quoteAssetDecimals),
    traderAddress: row.txFrom.toLowerCase() as Address,
  };
}
