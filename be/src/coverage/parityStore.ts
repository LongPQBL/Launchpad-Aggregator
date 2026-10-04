import type { Pool, PoolClient } from 'pg';
import type { ParityReport } from './launchParity.js';

export async function saveParityReport(db: Pool | PoolClient, report: ParityReport): Promise<void> {
  const details = JSON.stringify(report, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  await db.query(`INSERT INTO launch_parity_reports
    (source_id, registry_version, from_block, to_block, fence_block, envio_watermark, app_watermark,
      provider, status, chain_count, envio_count, app_count, first_block, last_block, details, audited_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
    ON CONFLICT (source_id, from_block, to_block, fence_block) DO UPDATE SET
      registry_version = EXCLUDED.registry_version, envio_watermark = EXCLUDED.envio_watermark,
      app_watermark = EXCLUDED.app_watermark, provider = EXCLUDED.provider, status = EXCLUDED.status,
      chain_count = EXCLUDED.chain_count, envio_count = EXCLUDED.envio_count, app_count = EXCLUDED.app_count,
      first_block = EXCLUDED.first_block, last_block = EXCLUDED.last_block,
      details = EXCLUDED.details, audited_at = now()`, [
    report.sourceId, report.registryVersion, report.fromBlock.toString(), report.toBlock.toString(), report.fence.toString(),
    report.envioWatermark.toString(), report.appWatermark.toString(), report.provider, report.status,
    report.counts.chain, report.counts.envio, report.counts.app,
    report.firstBlock?.toString() ?? null, report.lastBlock?.toString() ?? null, details,
  ]);
}
