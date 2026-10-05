import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { comparePoolSourceWindow, recordPoolSourceParity, rpcSourceLogReader } from '../pools/parity.js';
import type { AdditionalPoolProtocol } from '../pools/sourceRegistry.js';

const protocol = process.argv[2] as AdditionalPoolProtocol;
const from = process.argv[3];
const to = process.argv[4];
const samplePoolAddress = process.argv[5];
if (!['uniswap_v3', 'uniswap_v2'].includes(protocol) || !from || !to || !samplePoolAddress) {
  throw new Error('Usage: npm run pools:parity -- uniswap_v3|uniswap_v2 fromBlock toBlock samplePoolAddress');
}
const envioUrl = process.env.ENVIO_DATABASE_URL;
if (!envioUrl) throw new Error('ENVIO_DATABASE_URL is required');
const appUrl = process.env.DATABASE_URL;
if (!appUrl) throw new Error('DATABASE_URL is required');
const envio = new Pool({ connectionString: envioUrl });
const { db, pool } = createDatabase(appUrl);
try {
  const report = await comparePoolSourceWindow(envio,
    rpcSourceLogReader(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'),
    { protocol, chainId: 4663, fromBlock: BigInt(from), toBlock: BigInt(to), samplePoolAddress });
  const progress = await pool.query('SELECT head_block FROM envio_chain_progress WHERE chain_id=4663');
  const head = progress.rows[0]?.head_block === null || progress.rows[0]?.head_block === undefined
    ? 0n : BigInt(String(progress.rows[0].head_block));
  const safeHead = head > 500n ? head - 500n : 0n;
  const status = process.env.POOL_PARITY_APPLY === 'true'
    ? await recordPoolSourceParity(db, report, 4663, safeHead) : 'read_only';
  console.log(JSON.stringify({ ...report, status, safeHead: safeHead.toString() }));
  if (!report.complete) process.exitCode = 1;
} finally { await envio.end(); await pool.end(); }
