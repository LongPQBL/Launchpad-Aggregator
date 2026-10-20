import { sources } from '../db/schema.js';
import type { DbOrTx } from '../db/client.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';

/**
 * Launches, venues and lifecycle rows point at a `sources` row, and nothing else creates the static ones: the old RPC indexer
 * that used to seed them is gone. A fresh database would otherwise fail its first launch insert on a foreign key. Idempotent —
 * an existing row (and its progress) is never touched. `fromBlock` is the indexed window's first block, when there is one.
 */
export async function ensurePonsSources(db: DbOrTx, chainId: number, fromBlock: bigint | null): Promise<void> {
  const factories = getPonsFactorySources();
  const v2Factory = factories.find((source) => source.version === 'v2');
  const rows = [
    ...factories.map((source) => ({ id: source.id, version: source.version, factoryAddress: source.factory, startBlock: source.startBlock })),
    ...factories.filter((source) => source.version === 'v1').map((source) => ({
      id: `${source.id}-trades`, version: source.version, factoryAddress: source.factory, startBlock: source.startBlock })),
    ...(v2Factory ? ['pons-v2-curve', 'pons-v2-lifecycle'].map((id) => ({
      id, version: 'v2' as const, factoryAddress: v2Factory.factory, startBlock: v2Factory.startBlock })) : []),
  ];
  await db.insert(sources).values(rows.map((row) => {
    const startBlock = fromBlock !== null && fromBlock > row.startBlock ? fromBlock : row.startBlock;
    return { id: row.id, chainId, version: row.version, factoryAddress: row.factoryAddress, startBlock,
      scannedToBlock: startBlock, confirmedToBlock: startBlock, status: 'backfilling' };
  })).onConflictDoNothing();
}
