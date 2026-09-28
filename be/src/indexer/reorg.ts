import type { Hash } from 'viem';

export interface ObservedBlock {
  number: bigint;
  hash: Hash;
}

export interface ReorgDeps {
  reorgWindow: bigint;
  getStoredBlocks(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<readonly ObservedBlock[]>;
  getCanonicalBlockHash(chainId: number, blockNumber: bigint): Promise<Hash>;
  retractBlocks(chainId: number, fromBlock: bigint): Promise<void>;
  scanToSafeHead(chainId: number, safeHead: bigint): Promise<void>;
}

export interface ReorgReport {
  chainId: number;
  safeHead: bigint;
  reorgFromBlock: bigint | null;
}

export async function reconcileCanonicalHead(chainId: number, safeHead: bigint, deps: ReorgDeps): Promise<ReorgReport> {
  if (deps.reorgWindow < 1n) throw new Error('reorgWindow must be positive');
  const fromBlock = safeHead >= deps.reorgWindow ? safeHead - deps.reorgWindow + 1n : 0n;
  const observed = await deps.getStoredBlocks(chainId, fromBlock, safeHead);
  let firstMismatch: bigint | null = null;
  for (const block of [...observed].sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0)) {
    const canonical = await deps.getCanonicalBlockHash(chainId, block.number);
    if (canonical.toLowerCase() !== block.hash.toLowerCase()) {
      firstMismatch = block.number;
      break;
    }
  }
  if (firstMismatch !== null) {
    await deps.retractBlocks(chainId, firstMismatch);
    await deps.scanToSafeHead(chainId, safeHead);
  }
  return { chainId, safeHead, reorgFromBlock: firstMismatch };
}
