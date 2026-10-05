import type { Address } from 'viem';
import type { Database } from '../../db/client.js';
import { readV1CoreMetadataOutcomes, readV2CoreMetadataOutcomes } from './coreMetadata.js';
import { readExtendedTokenMetadataOutcomes, readLaunchTimestamp,
  type BlockReadClient, type ExtendedMetadataReadClient, type ReadOutcome } from './extendedMetadata.js';
import { claimDueMetadataLaunches, finishCoreMetadataLaunch, finishMetadataLaunch } from './metadataEnrichmentStore.js';
import { notifyChanged } from '../../envioSync/notifyChanges.js';
import type { V1ReadClient } from './v1/state.js';
import type { V2QuoteClient } from './v2/adapter.js';

export function resolveMetadataBatchLimit(raw: string | undefined): number {
  const limit = raw === undefined ? 10 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid metadata batch limit');
  return limit;
}

interface MetadataEnrichmentReport {
  claimed: number;
  completed: number;
  pending: number;
  transportFailures: number;
  unknownFailures: number;
}

export async function enrichMetadataOnce(
  db: Database, client: ExtendedMetadataReadClient & BlockReadClient & V1ReadClient & V2QuoteClient, now: Date, limit = 10,
): Promise<MetadataEnrichmentReport> {
  const claims = await claimDueMetadataLaunches(db, now, limit, 600_000);
  let completed = 0;
  let pending = 0;
  let transportFailures = 0;
  let unknownFailures = 0;
  for (const claim of claims) {
    // Core metadata (name/symbol/decimals; V1 graduation; V2 unknown quote asset) is read and saved
    // FIRST, before extended fields — see finishCoreMetadataLaunch's own comment for why the order
    // matters (it never clears the shared lease; finishMetadataLaunch below always does).
    let corePending = false;
    if (claim.coreMetadataReadState === 'pending') {
      const core = claim.protocolVersion === 'v1'
        ? await readV1CoreMetadataOutcomes(client, claim.tokenAddress as Address, claim.factoryAddress as Address)
        : await readV2CoreMetadataOutcomes(client, claim.tokenAddress as Address, claim.quoteAssetAddress as Address, claim.quoteAssetSymbol === null);
      for (const outcome of [core.name, core.symbol, core.decimals, core.graduated, core.quoteAssetSymbol, core.quoteAssetDecimals]) {
        if (outcome.state === 'pending' && outcome.errorKind === 'transport') transportFailures++;
        if (outcome.state === 'pending' && outcome.errorKind === 'unknown') unknownFailures++;
      }
      const coreSaved = await finishCoreMetadataLaunch(db, claim, core, now);
      // Not wrapped in a transaction (finishCoreMetadataLaunch is its own atomic UPDATE) — notify
      // right after a successful save, same as "verified metadata arrives" in the spec's near-
      // realtime design, even if some individual fields (e.g. decimals alone) are still pending.
      if (coreSaved) await notifyChanged(db, [{ kind: 'launch.changed', chainId: claim.chainId, tokenAddress: claim.tokenAddress }]);
      corePending = !coreSaved || [core.name, core.symbol, core.decimals, core.graduated, core.quoteAssetSymbol, core.quoteAssetDecimals]
        .some((outcome) => outcome.state === 'pending');
    }

    const functions: ('logo' | 'description' | 'socials')[] = [];
    if (claim.logoReadState === 'pending') functions.push('logo');
    if (claim.descriptionReadState === 'pending') functions.push('description');
    if (claim.socialsReadState === 'pending') functions.push('socials');
    const extended = await readExtendedTokenMetadataOutcomes(client, claim.tokenAddress as Address, functions);
    const timestamp: ReadOutcome<number> = claim.timestampReadState === 'pending'
      ? await readLaunchTimestamp(client, claim.launchBlock) : { state: 'done', value: null };
    const results = { ...extended, timestamp };
    for (const outcome of [results.logo, results.description, results.socials, results.timestamp]) {
      if (outcome.state === 'pending' && outcome.errorKind === 'transport') transportFailures++;
      if (outcome.state === 'pending' && outcome.errorKind === 'unknown') unknownFailures++;
    }
    const saved = await finishMetadataLaunch(db, claim, results, now);
    const stillPending = corePending || !saved
      || (claim.logoReadState === 'pending' && results.logo.state === 'pending')
      || (claim.descriptionReadState === 'pending' && results.description.state === 'pending')
      || (claim.socialsReadState === 'pending' && results.socials.state === 'pending')
      || (claim.timestampReadState === 'pending' && results.timestamp.state === 'pending');
    if (stillPending) pending++;
    else completed++;
  }
  return { claimed: claims.length, completed, pending, transportFailures, unknownFailures };
}

export async function enrichMetadataSafely(
  db: Database, client: ExtendedMetadataReadClient & BlockReadClient, now: Date,
  log: (event: { kind: string; claimed?: number; completed?: number; pending?: number;
    transportFailures?: number; unknownFailures?: number }) => void,
  limit = 10,
): Promise<void> {
  try {
    const result = await enrichMetadataOnce(db, client, now, limit);
    log({ kind: 'enrichment_complete', ...result });
  } catch {
    // Errors can include provider URLs. Report only a fixed category here.
    log({ kind: 'enrichment_error' });
  }
}

export function startMetadataEnrichmentLoop(run: () => Promise<void>): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve().then(run).catch(() => { /* caller uses enrichMetadataSafely */ })
      .finally(() => { active = null; });
  };
  const interval = setInterval(tick, 60_000);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      if (active) await active;
    },
  };
}
