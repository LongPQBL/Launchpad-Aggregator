import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { CoreMetadataReadResults } from './coreMetadata.js';
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
  protocolVersion: string;
  factoryAddress: string;
  quoteAssetAddress: string;
  quoteAssetSymbol: string | null;
  coreMetadataReadState: string;
  coreMetadataRetryCount: number;
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
  protocol_version: string;
  factory_address: string;
  quote_asset_address: string;
  quote_asset_symbol: string | null;
  core_metadata_read_state: string;
  core_metadata_retry_count: number;
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
    // Existing row leases also mark a pass that is still making RPC calls. The budget-row lock
    // serializes this check with new claims across Envio processes, without a session DB lock.
    const activePass = await client.query(`SELECT 1 FROM launches
      WHERE chain_id = 4663 AND platform = 'pons' AND protocol_version IN ('v1', 'v2')
        AND metadata_lease_until > $1 LIMIT 1`, [now]);
    if (activePass.rowCount) {
      await client.query('COMMIT');
      return [];
    }
    const selected: DueRow[] = [];
    async function pick(direction: 'ASC' | 'DESC', count: number) {
      if (count <= 0) return;
      // A row qualifies if EITHER its core fields (name/symbol/decimals; V1 graduation; V2 unknown
      // quote asset) or its extended fields are due — each on its own independent retry schedule, so
      // a slow extended-field backoff can never delay a more urgent core-metadata retry.
      const rows = await client.query<DueRow>(`SELECT chain_id, token_address, launch_block, launch_tx_hash,
        launch_log_index, metadata_retry_count, logo_read_state, description_read_state,
        socials_read_state, timestamp_read_state, protocol_version, factory_address,
        quote_asset_address, quote_asset_symbol, core_metadata_read_state, core_metadata_retry_count
        FROM launches
        WHERE chain_id = 4663 AND platform = 'pons' AND protocol_version IN ('v1', 'v2')
          AND (
            (core_metadata_read_state = 'pending' AND (core_metadata_retry_at IS NULL OR core_metadata_retry_at <= $1))
            OR (
              (logo_read_state = 'pending' OR description_read_state = 'pending'
                OR socials_read_state = 'pending' OR timestamp_read_state = 'pending')
              AND (metadata_retry_at IS NULL OR metadata_retry_at <= $1)
            )
          )
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
        timestampReadState: row.timestamp_read_state, protocolVersion: row.protocol_version,
        factoryAddress: row.factory_address, quoteAssetAddress: row.quote_asset_address,
        quoteAssetSymbol: row.quote_asset_symbol, coreMetadataReadState: row.core_metadata_read_state,
        coreMetadataRetryCount: row.core_metadata_retry_count,
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

// Called BEFORE finishMetadataLaunch for the same claim when both are due together: this function
// deliberately never clears the shared lease, so finishMetadataLaunch's own (always-called) update
// is the single place that releases it — calling both in the other order would make this update's own
// `metadata_lease_id = claim.leaseId` guard find nothing, since the lease would already be cleared.
export async function finishCoreMetadataLaunch(
  db: Database, claim: ClaimedMetadataLaunch, result: CoreMetadataReadResults, now: Date,
): Promise<boolean> {
  if (claim.coreMetadataReadState !== 'pending') return true;
  const nameDone = result.name.state === 'done';
  const symbolDone = result.symbol.state === 'done';
  const decimalsDone = result.decimals.state === 'done';
  const graduatedDone = result.graduated.state === 'done';
  const quoteSymbolDone = result.quoteAssetSymbol.state === 'done';
  const quoteDecimalsDone = result.quoteAssetDecimals.state === 'done';
  const allDone = nameDone && symbolDone && decimalsDone && graduatedDone && quoteSymbolDone && quoteDecimalsDone;
  const retryCount = allDone ? 0 : claim.coreMetadataRetryCount + 1;
  const retryAt = allDone ? null : nextMetadataRetryAt(now, claim.coreMetadataRetryCount);
  const graduatedToTrue = claim.protocolVersion === 'v1' && graduatedDone && result.graduated.value === true;
  const updated = await db.$client.query(`UPDATE launches SET
    name = CASE WHEN $1 AND $2::text IS NOT NULL THEN $2 ELSE name END,
    symbol = CASE WHEN $3 AND $4::text IS NOT NULL THEN $4 ELSE symbol END,
    token_decimals = CASE WHEN $5 AND $6::integer IS NOT NULL THEN $6 ELSE token_decimals END,
    quote_asset_symbol = CASE WHEN $7 AND $8::text IS NOT NULL THEN $8 ELSE quote_asset_symbol END,
    quote_asset_decimals = CASE WHEN $9 AND $10::integer IS NOT NULL THEN $10 ELSE quote_asset_decimals END,
    lifecycle_status = CASE WHEN $11 THEN 'graduated' ELSE lifecycle_status END,
    core_metadata_read_state = CASE WHEN $12 THEN 'done' ELSE core_metadata_read_state END,
    core_metadata_retry_at = $13, core_metadata_retry_count = $14
    WHERE chain_id = $15 AND token_address = $16 AND metadata_lease_id = $17`, [
    nameDone, result.name.value, symbolDone, result.symbol.value, decimalsDone, result.decimals.value,
    quoteSymbolDone, result.quoteAssetSymbol.value, quoteDecimalsDone, result.quoteAssetDecimals.value,
    graduatedToTrue, allDone, retryAt, retryCount, claim.chainId, claim.tokenAddress, claim.leaseId,
  ]);
  return updated.rowCount === 1;
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
