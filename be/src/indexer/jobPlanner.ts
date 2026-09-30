export interface SourceDefinition {
  id: string;
  startBlock: bigint;
  verifiedInitialize?: boolean;
}

export interface ScanWindow { fromBlock: bigint; toBlock: bigint }

export interface PlannerOptions {
  maxWindowBlocks: bigint;
  maxJobs: number;
  targetWorkUnits: bigint;
}

export interface DependencyLimit { ready: boolean; maximumBlock: bigint | null }

export function dependencyFrontier(sourceId: string, frontiers: ReadonlyMap<string, bigint>): DependencyLimit {
  const factories = getPonsFactorySources();
  if (factories.some((factory) => factory.id === sourceId)) return { ready: true, maximumBlock: null };
  const required = sourceId === 'pons-v2-lifecycle' ? ['pons-v2']
    : sourceId.startsWith('pons-v2-v4:') ? ['pons-v2-lifecycle']
      : getTradeSourceDefinitions().find((definition) => definition.source.id === sourceId)?.factorySourceIds;
  if (!required) throw new Error(`Unknown indexer source: ${sourceId}`);
  const values = required.map((id) => frontiers.get(id));
  if (values.some((value) => value === undefined)) return { ready: false, maximumBlock: null };
  return { ready: true, maximumBlock: (values as bigint[]).reduce((lowest, value) => value < lowest ? value : lowest) };
}

export async function planCertifiedJobs(source: SourceDefinition, fromBlock: bigint, safeHead: bigint,
  upstreamFrontiers: ReadonlyMap<string, bigint>, estimatePoolCount: (fromBlock: bigint, toBlock: bigint) => Promise<number>,
  options?: Partial<PlannerOptions>): Promise<ScanWindow[]> {
  const maxWindowBlocks = options?.maxWindowBlocks ?? 2_000n;
  const maxJobs = options?.maxJobs ?? 100;
  const targetWorkUnits = options?.targetWorkUnits ?? 100_000_000n;
  if (fromBlock < 0n || source.startBlock < 0n || safeHead < 0n || maxWindowBlocks < 1n
    || maxWindowBlocks > 2_000n || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || targetWorkUnits < 1n) {
    throw new Error('Invalid scan job planning bounds');
  }
  if (source.id.startsWith('pons-v2-v4:') && source.verifiedInitialize !== true) return [];
  const limit = dependencyFrontier(source.id, upstreamFrontiers);
  if (!limit.ready) return [];
  const last = limit.maximumBlock !== null && limit.maximumBlock < safeHead ? limit.maximumBlock : safeHead;
  const windows: ScanWindow[] = [];
  let next = fromBlock > source.startBlock ? fromBlock : source.startBlock;
  while (next <= last && windows.length < maxJobs) {
    const maxEnd = next + maxWindowBlocks - 1n < last ? next + maxWindowBlocks - 1n : last;
    const poolCount = await estimatePoolCount(next, maxEnd);
    if (!Number.isSafeInteger(poolCount) || poolCount < 0) throw new Error('Invalid eligible pool count');
    const workSized = poolCount === 0 ? maxWindowBlocks : targetWorkUnits / BigInt(poolCount);
    const width = workSized < 1n ? 1n : workSized < maxWindowBlocks ? workSized : maxWindowBlocks;
    const toBlock = next + width - 1n < last ? next + width - 1n : last;
    windows.push({ fromBlock: next, toBlock });
    next = toBlock + 1n;
  }
  return windows;
}
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { getTradeSourceDefinitions } from './tradeRuntime.js';
