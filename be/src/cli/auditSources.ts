import { readFileSync } from 'node:fs';
import type { Address, Hash } from 'viem';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';

interface LaunchFixture {
  sourceId: string;
  address: Address;
  blockNumber: number;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
  topics: Hash[];
  data: Hash;
}

interface Provenance {
  v2Deployment: {
    blockNumber: number;
    transactionHash: Hash;
    rpcReceiptContractAddress: Address;
  };
}

const httpUrl = process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const client = createRobinhoodPublicClient(httpUrl);
const fixtures = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/pons-launches.json', import.meta.url), 'utf8'),
) as LaunchFixture[];
const provenance = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/provenance.json', import.meta.url), 'utf8'),
) as Provenance;

for (const source of getPonsFactorySources()) {
  const fixture = fixtures.find((item) => item.sourceId === source.id);
  if (!fixture) throw new Error(`Missing fixture for ${source.id}`);
  const bytecode = await client.getBytecode({ address: source.factory });
  if (!bytecode || bytecode === '0x') throw new Error(`No live bytecode for ${source.id}`);
  const logs = await client.getLogs({
    address: source.factory,
    fromBlock: BigInt(fixture.blockNumber),
    toBlock: BigInt(fixture.blockNumber),
  });
  const match = logs.find(
    (log) =>
      log.transactionHash?.toLowerCase() === fixture.txHash.toLowerCase() &&
      log.blockHash?.toLowerCase() === fixture.blockHash.toLowerCase() &&
      log.logIndex === fixture.logIndex &&
      log.topics[0] === source.launchTopic &&
      log.data === fixture.data,
  );
  if (!match) throw new Error(`Fixture did not match chain log for ${source.id}`);
  console.log(JSON.stringify({ sourceId: source.id, startBlock: source.startBlock.toString(), sampleBlock: fixture.blockNumber, bytecodeBytes: (bytecode.length - 2) / 2 }));
}

const deployment = provenance.v2Deployment;
const receipt = await client.getTransactionReceipt({ hash: deployment.transactionHash });
if (
  receipt.blockNumber !== BigInt(deployment.blockNumber) ||
  receipt.contractAddress?.toLowerCase() !== deployment.rpcReceiptContractAddress.toLowerCase() ||
  receipt.status !== 'success'
) {
  throw new Error('Pons v2 deployment receipt did not match provenance');
}
console.log(JSON.stringify({ sourceId: 'pons-v2', deploymentBlock: receipt.blockNumber.toString(), deploymentTx: deployment.transactionHash }));
