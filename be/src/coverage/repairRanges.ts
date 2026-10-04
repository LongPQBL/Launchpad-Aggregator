import type { Pool } from 'pg';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';

export interface LaunchParityCoverage {
  sourceId: string; status: 'complete' | 'mismatch' | 'pending' | 'unverified';
  auditedToBlock: string | null; finalizedTargetBlock: string | null;
  envioWatermark: string | null; appWatermark: string | null;
}

export async function readLaunchParityCoverage(pool: Pool, source: FactorySource, finalizedTarget: bigint | null): Promise<LaunchParityCoverage> {
  const result = await pool.query(`SELECT from_block, to_block, status, registry_version,
      envio_watermark, app_watermark FROM launch_parity_reports WHERE source_id = $1
    ORDER BY from_block, to_block, fence_block DESC, audited_at DESC`, [source.id]);
  const rows = result.rows as Record<string, unknown>[];
  let next = source.startBlock;
  let mismatch = false;
  let envioWatermark: bigint | null = null;
  let appWatermark: bigint | null = null;
  const seenRanges = new Set<string>();
  for (const row of rows) {
    if (Number(row.registry_version) !== source.registryVersion) continue;
    const from = BigInt(String(row.from_block));
    const to = BigInt(String(row.to_block));
    if (finalizedTarget !== null && from > finalizedTarget) continue;
    const rangeKey = `${from}:${to}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);
    if (row.status === 'mismatch') mismatch = true;
    const envio = BigInt(String(row.envio_watermark));
    const app = BigInt(String(row.app_watermark));
    envioWatermark = envioWatermark === null || envio > envioWatermark ? envio : envioWatermark;
    appWatermark = appWatermark === null || app > appWatermark ? app : appWatermark;
    if (row.status === 'complete' && from <= next && to >= next) next = to + 1n;
  }
  const status: LaunchParityCoverage['status'] = seenRanges.size === 0 ? 'unverified' : mismatch ? 'mismatch'
    : finalizedTarget === null || next <= finalizedTarget ? 'pending' : 'complete';
  return { sourceId: source.id, status, auditedToBlock: next > source.startBlock ? (next - 1n).toString() : null,
    finalizedTargetBlock: finalizedTarget?.toString() ?? null,
    envioWatermark: envioWatermark?.toString() ?? null, appWatermark: appWatermark?.toString() ?? null };
}

export async function enqueueParityRepair(
  pool: Pool, sourceId: string, fromBlock: bigint, toBlock: bigint, failureLayer: 'envio' | 'app',
): Promise<void> {
  if (fromBlock > toBlock) throw new Error('Invalid parity repair range');
  const action = failureLayer === 'envio' ? 'envio_reindex' : 'app_promotion';
  await pool.query(`INSERT INTO launch_parity_repairs (source_id, from_block, to_block, failure_layer, action, status)
    VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (source_id,from_block,to_block,failure_layer) DO NOTHING`,
  [sourceId, fromBlock.toString(), toBlock.toString(), failureLayer, action]);
}

export async function resolveParityRepairs(pool: Pool, sourceId: string, fromBlock: bigint, toBlock: bigint): Promise<void> {
  const latest = await pool.query(`SELECT status FROM launch_parity_reports
    WHERE source_id = $1 AND from_block = $2 AND to_block = $3
    ORDER BY fence_block DESC, audited_at DESC LIMIT 1`, [sourceId, fromBlock.toString(), toBlock.toString()]);
  if (latest.rows[0]?.status !== 'complete') throw new Error('Cannot resolve repair before successful parity audit');
  await pool.query(`UPDATE launch_parity_repairs SET status = 'done'
    WHERE source_id = $1 AND from_block = $2 AND to_block = $3 AND status = 'pending'`,
  [sourceId, fromBlock.toString(), toBlock.toString()]);
}
