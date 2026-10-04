import { readFile } from 'node:fs/promises';
import { toHex } from 'viem';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { validateLaunchSourceConfig } from '../coverage/sourceRegistryCheck.js';
import { parseAuditRangeArgs, readLaunchEvidence, type LaunchLogFilter } from '../coverage/readLaunchEvidence.js';

const args = parseAuditRangeArgs(process.argv.slice(2));
const source = getPonsFactorySources().find((item) => item.id === args.sourceId);
if (!source) throw new Error(`Unknown launch source: ${args.sourceId}`);
const config = await readFile(new URL('../../../envio/config.yaml', import.meta.url), 'utf8');
const handlers = await readFile(new URL('../../../envio/src/EventHandlers.ts', import.meta.url), 'utf8');
const issues = validateLaunchSourceConfig(getPonsFactorySources(), config, handlers);
if (issues.length) throw new Error(`Envio source configuration differs from registry: ${JSON.stringify(issues)}`);

const rpc = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
const events = await readLaunchEvidence({
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
}, source, args.fromBlock, args.toBlock, args.maxRange, { finalizedFence: args.finalizedFence });

console.log(JSON.stringify({ sourceId: source.id, fromBlock: args.fromBlock.toString(),
  toBlock: args.toBlock.toString(), finalizedFence: args.finalizedFence.toString(),
  provider: process.env.RH_HTTP_RPC_URL ? 'RH_HTTP_RPC_URL' : 'public-robinhood',
  chainEventCount: events.length, firstBlock: events[0]?.blockNumber.toString() ?? null,
  lastBlock: events.at(-1)?.blockNumber.toString() ?? null }));
