import { parseAbiItem, toEventSelector } from 'viem';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { scanToHead, type LogSource, type ScanDeps, type ScanReport } from '../indexer/scan.js';

const v1LaunchEvent = parseAbiItem('event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)');
const v2LaunchEvent = parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');

export function getFactoryLogSources(): LogSource[] {
  return getPonsFactorySources().map((source) => {
    const event = source.version === 'v1' ? v1LaunchEvent : v2LaunchEvent;
    if (toEventSelector(event) !== source.launchTopic) throw new Error(`ABI topic mismatch for ${source.id}`);
    return { id: source.id, chainId: source.chainId, startBlock: source.startBlock, addresses: [source.factory], events: [event] };
  });
}

export function createViemGetLogs(client: ReturnType<typeof createRobinhoodPublicClient>): ScanDeps['getLogs'] {
  return async (source, fromBlock, toBlock) => {
    if (source.events.length === 0) throw new Error(`No event filter for ${source.id}`);
    return client.getLogs({
      address: [...source.addresses],
      events: [...source.events],
      fromBlock,
      toBlock,
    });
  };
}

export async function runIndexerOnce(
  sources: readonly LogSource[],
  getSafeHead: (chainId: number) => Promise<bigint>,
  depsForSource: (source: LogSource) => ScanDeps | undefined,
): Promise<ScanReport[]> {
  const configured = sources.map((source) => {
    const deps = depsForSource(source);
    if (!deps) throw new Error(`Missing decoder for ${source.id}`);
    return { source, deps };
  });
  const reports: ScanReport[] = [];
  for (const { source, deps } of configured) {
    const safeHead = await getSafeHead(source.chainId);
    reports.push(await scanToHead(source, safeHead, deps));
  }
  return reports;
}
