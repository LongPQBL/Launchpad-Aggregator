import type { Address, Hash } from 'viem';
import { derivePonsV4PoolId, transitionOfficialVenue, type GraduatedPoolEvidence, type V4PoolTerms } from '../launchpads/pons/v2/poolKey.js';
import type { Launch, Venue } from '../domain/types.js';

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
  return { poolId: row.poolId.toLowerCase() as Hash, sourceLogId: `v4-init-${row.txHash.toLowerCase()}-${row.logIndex}`, sourceId: 'pons-v2-v4' };
}

export function openV4Venue(launch: Launch, curveVenue: Venue, evidence: GraduatedPoolEvidence, position: { blockNumber: bigint; logIndex: number }): Venue {
  const transition = transitionOfficialVenue(launch, curveVenue, 2, position, evidence);
  if (!transition.openedPool) throw new Error('Expected an opened V4 pool venue');
  return transition.openedPool;
}
