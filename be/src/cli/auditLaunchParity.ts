import { readFile } from 'node:fs/promises';
import { toHex } from 'viem';
import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { validateLaunchSourceConfig } from '../coverage/sourceRegistryCheck.js';
import { parseAuditRangeArgs, readLaunchEvidence, validateAuditFence, type LaunchLogFilter } from '../coverage/readLaunchEvidence.js';
import { compareLaunchRange, readAppLaunchRange, readEnvioLaunchRange, repairLayers } from '../coverage/launchParity.js';
import { saveParityReport } from '../coverage/parityStore.js';
import { enqueueParityRepair, resolveParityRepairs } from '../coverage/repairRanges.js';
import { readEnvioProgress } from '../envioSync/envioDb.js';

const args = parseAuditRangeArgs(process.argv.slice(2));
const source = getPonsFactorySources().find((item) => item.id === args.sourceId);
if (!source) throw new Error(`Unknown launch source: ${args.sourceId}`);
const config = await readFile(new URL('../../../envio/config.yaml', import.meta.url), 'utf8');
const handlers = await readFile(new URL('../../../envio/src/EventHandlers.ts', import.meta.url), 'utf8');
const issues = validateLaunchSourceConfig(getPonsFactorySources(), config, handlers);
if (issues.length) throw new Error(`Envio source configuration differs from registry: ${JSON.stringify(issues)}`);

const envioUrl = process.env.ENVIO_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!envioUrl || !appUrl) throw new Error('ENVIO_DATABASE_URL and DATABASE_URL are required');
const persist = process.argv.includes('--persist') && process.argv[process.argv.indexOf('--persist') + 1] === 'yes';
if (persist && !new URL(appUrl).pathname.endsWith('_test') && process.env.AUDIT_ALLOW_LIVE_WRITE !== '1') {
  throw new Error('Refusing to write parity reports to a non-test DB without AUDIT_ALLOW_LIVE_WRITE=1');
}
const envioPool = new Pool({ connectionString: envioUrl, connectionTimeoutMillis: 3000 });
const appPool = new Pool({ connectionString: appUrl, connectionTimeoutMillis: 3000 });
const rpc = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
const chainClient = {
  async getLogs(filter: LaunchLogFilter) {
    const rows = await rpc.request({ method: 'eth_getLogs', params: [{
      address: filter.address, topics: [filter.topic],
      fromBlock: toHex(filter.fromBlock), toBlock: toHex(filter.toBlock),
    }] });
    return rows.map((row) => {
      if (!row.blockHash || !row.transactionHash || !row.blockNumber || !row.logIndex) {
        throw new Error('Non-finalized log in launch audit range');
      }
      return { address: row.address, topics: row.topics, blockNumber: BigInt(row.blockNumber),
        blockHash: row.blockHash, transactionHash: row.transactionHash, logIndex: Number(row.logIndex) };
    });
  },
};

try {
  // Fail before making RPC calls when either database is unavailable.
  await Promise.all([envioPool.query('SELECT 1'), appPool.query('SELECT 1')]);
  validateAuditFence(args.toBlock, args.finalizedFence, await rpc.getBlockNumber());
  const { processedBlock } = await readEnvioProgress(envioPool);
  const appRow = await appPool.query('SELECT confirmed_to_block FROM sources WHERE id = $1', [source.id]);
  const appWatermark = appRow.rows[0]?.confirmed_to_block === undefined
    ? source.startBlock - 1n : BigInt(String(appRow.rows[0].confirmed_to_block));
  for (let from = args.fromBlock; from <= args.toBlock; from += args.maxRange) {
    const to = from + args.maxRange - 1n < args.toBlock ? from + args.maxRange - 1n : args.toBlock;
    const [chainEvents, envioRows, appRows] = await Promise.all([
      readLaunchEvidence(chainClient, source, from, to, args.maxRange, { finalizedFence: args.finalizedFence }),
      readEnvioLaunchRange(envioPool, source, from, to),
      readAppLaunchRange(appPool, source, from, to),
    ]);
    const report = compareLaunchRange({ source, fromBlock: from, toBlock: to, fence: args.finalizedFence,
      chainEvents, envioRows, appRows, envioWatermark: processedBlock, appWatermark,
      provider: process.env.RH_HTTP_RPC_URL ? 'RH_HTTP_RPC_URL' : 'public-robinhood' });
    if (persist) {
      await saveParityReport(appPool, report);
      for (const layer of repairLayers(report)) await enqueueParityRepair(appPool, source.id, from, to, layer);
      if (report.status === 'complete') await resolveParityRepairs(appPool, source.id, from, to);
    }
    console.log(JSON.stringify(report, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
  }
} finally {
  await Promise.all([envioPool.end(), appPool.end()]);
}
