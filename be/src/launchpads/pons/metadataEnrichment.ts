import type { Address } from 'viem';
import type { Database } from '../../db/client.js';
import { readExtendedTokenMetadataOutcomes, readLaunchTimestamp,
  type BlockReadClient, type ExtendedMetadataReadClient, type ReadOutcome } from './extendedMetadata.js';
import { claimDueMetadataLaunches, finishMetadataLaunch } from './metadataEnrichmentStore.js';

export async function enrichMetadataOnce(
  db: Database, client: ExtendedMetadataReadClient & BlockReadClient, now: Date, limit = 10,
): Promise<{ claimed: number; completed: number; pending: number }> {
  const claims = await claimDueMetadataLaunches(db, now, limit, 600_000);
  let completed = 0;
  let pending = 0;
  for (const claim of claims) {
    const functions: ('logo' | 'description' | 'socials')[] = [];
    if (claim.logoReadState === 'pending') functions.push('logo');
    if (claim.descriptionReadState === 'pending') functions.push('description');
    if (claim.socialsReadState === 'pending') functions.push('socials');
    const extended = await readExtendedTokenMetadataOutcomes(client, claim.tokenAddress as Address, functions);
    const timestamp: ReadOutcome<number> = claim.timestampReadState === 'pending'
      ? await readLaunchTimestamp(client, claim.launchBlock) : { state: 'done', value: null };
    const results = { ...extended, timestamp };
    const saved = await finishMetadataLaunch(db, claim, results, now);
    const stillPending = !saved
      || (claim.logoReadState === 'pending' && results.logo.state === 'pending')
      || (claim.descriptionReadState === 'pending' && results.description.state === 'pending')
      || (claim.socialsReadState === 'pending' && results.socials.state === 'pending')
      || (claim.timestampReadState === 'pending' && results.timestamp.state === 'pending');
    if (stillPending) pending++;
    else completed++;
  }
  return { claimed: claims.length, completed, pending };
}

export async function enrichMetadataSafely(
  db: Database, client: ExtendedMetadataReadClient & BlockReadClient, now: Date,
  log: (event: { kind: string; claimed?: number; completed?: number; pending?: number }) => void,
): Promise<void> {
  try {
    const result = await enrichMetadataOnce(db, client, now);
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
