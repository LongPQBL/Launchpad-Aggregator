import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { mapMetadataReadResults, type MetadataReadResults } from './extendedMetadata.js';

export interface ClaimedMetadataLaunch {
  chainId: number;
  tokenAddress: string;
  launchBlock: bigint;
  launchTxHash: string;
  launchLogIndex: number;
  leaseId: string;
  retryCount: number;
  logoReadState: string;
  descriptionReadState: string;
  socialsReadState: string;
  timestampReadState: string;
}

interface DueRow {
  chain_id: number;
  token_address: string;
  launch_block: string;
  launch_tx_hash: string;
  launch_log_index: number;
  metadata_retry_count: number;
  logo_read_state: string;
  description_read_state: string;
  socials_read_state: string;
  timestamp_read_state: string;
}

export async function claimDueMetadataLaunches(db: Database, now: Date, limit: number, leaseMs: number): Promise<ClaimedMetadataLaunch[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid metadata batch limit');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600_000) throw new Error('Invalid metadata lease');
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    const budget = await client.query<{ last_started_at: Date | null }>(
      'SELECT last_started_at FROM metadata_enrichment_budget WHERE id = 1 FOR UPDATE',
    );
    if (budget.rowCount !== 1) throw new Error('Metadata enrichment budget is missing');
    if (budget.rows[0].last_started_at && now.getTime() - budget.rows[0].last_started_at.getTime() < 60_000) {
      await client.query('COMMIT');
      return [];
    }
    const selected: DueRow[] = [];
    async function pick(direction: 'ASC' | 'DESC', count: number) {
      if (count <= 0) return;
      const rows = await client.query<DueRow>(`SELECT chain_id, token_address, launch_block, launch_tx_hash,
        launch_log_index, metadata_retry_count, logo_read_state, description_read_state,
        socials_read_state, timestamp_read_state FROM launches
        WHERE chain_id = 4663 AND platform = 'pons' AND protocol_version IN ('v1', 'v2')
          AND (logo_read_state = 'pending' OR description_read_state = 'pending'
            OR socials_read_state = 'pending' OR timestamp_read_state = 'pending')
          AND (metadata_retry_at IS NULL OR metadata_retry_at <= $1)
          AND (metadata_lease_until IS NULL OR metadata_lease_until <= $1)
          AND NOT (token_address = ANY($2::text[]))
        ORDER BY launch_block ${direction}, launch_log_index ${direction}, token_address ${direction}
        LIMIT $3 FOR UPDATE SKIP LOCKED`, [now, selected.map((row) => row.token_address), count]);
      selected.push(...rows.rows);
    }
    await pick('DESC', Math.ceil(limit / 2));
    await pick('ASC', Math.floor(limit / 2));
    await pick('DESC', limit - selected.length);
    if (selected.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claims: ClaimedMetadataLaunch[] = [];
    for (const row of selected) {
      const leaseId = randomUUID();
      await client.query(`UPDATE launches SET metadata_lease_id = $1, metadata_lease_until = $2
        WHERE chain_id = $3 AND token_address = $4`, [leaseId, leaseUntil, row.chain_id, row.token_address]);
      claims.push({
        chainId: row.chain_id, tokenAddress: row.token_address, launchBlock: BigInt(row.launch_block),
        launchTxHash: row.launch_tx_hash, launchLogIndex: row.launch_log_index, leaseId,
        retryCount: row.metadata_retry_count, logoReadState: row.logo_read_state,
        descriptionReadState: row.description_read_state, socialsReadState: row.socials_read_state,
        timestampReadState: row.timestamp_read_state,
      });
    }
    await client.query('UPDATE metadata_enrichment_budget SET last_started_at = $1 WHERE id = 1', [now]);
    await client.query('COMMIT');
    return claims;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function finishMetadataLaunch(
  db: Database, claim: ClaimedMetadataLaunch, result: MetadataReadResults, now: Date,
): Promise<boolean> {
  const values = mapMetadataReadResults(result);
  const logoDone = claim.logoReadState === 'pending' && result.logo.state === 'done';
  const descriptionDone = claim.descriptionReadState === 'pending' && result.description.state === 'done';
  const socialsDone = claim.socialsReadState === 'pending' && result.socials.state === 'done';
  const timestampDone = claim.timestampReadState === 'pending' && result.timestamp.state === 'done';
  const pending = (claim.logoReadState === 'pending' && !logoDone)
    || (claim.descriptionReadState === 'pending' && !descriptionDone)
    || (claim.socialsReadState === 'pending' && !socialsDone)
    || (claim.timestampReadState === 'pending' && !timestampDone);
  const retryCount = pending ? claim.retryCount + 1 : 0;
  const retryAt = pending ? nextMetadataRetryAt(now, claim.retryCount) : null;
  const updated = await db.$client.query(`UPDATE launches SET
    logo_uri = CASE WHEN $1 THEN $2 ELSE logo_uri END,
    description = CASE WHEN $3 THEN $4 ELSE description END,
    website_url = CASE WHEN $5 THEN $6 ELSE website_url END,
    twitter_url = CASE WHEN $5 THEN $7 ELSE twitter_url END,
    launch_timestamp = CASE WHEN $8 THEN $9 ELSE launch_timestamp END,
    logo_read_state = CASE WHEN $1 THEN 'done' ELSE logo_read_state END,
    description_read_state = CASE WHEN $3 THEN 'done' ELSE description_read_state END,
    socials_read_state = CASE WHEN $5 THEN 'done' ELSE socials_read_state END,
    timestamp_read_state = CASE WHEN $8 THEN 'done' ELSE timestamp_read_state END,
    metadata_retry_at = $10, metadata_retry_count = $11,
    metadata_lease_id = NULL, metadata_lease_until = NULL
    WHERE chain_id = $12 AND token_address = $13 AND launch_block = $14 AND launch_tx_hash = $15
      AND launch_log_index = $16 AND metadata_lease_id = $17`, [
    logoDone, values.logoUri, descriptionDone, values.description,
    socialsDone, values.websiteUrl, values.twitterUrl, timestampDone, values.launchTimestamp,
    retryAt, retryCount, claim.chainId, claim.tokenAddress, claim.launchBlock.toString(),
    claim.launchTxHash, claim.launchLogIndex, claim.leaseId,
  ]);
  return updated.rowCount === 1;
}

export function nextMetadataRetryAt(now: Date, retryCount: number): Date {
  return new Date(now.getTime() + Math.min(60 * 2 ** Math.min(retryCount, 6), 3600) * 1000);
}
