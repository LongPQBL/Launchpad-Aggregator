import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import type { Address, Hash } from 'viem';
import type { CoverageStatus, IndexBatch, SourceCursor } from '../domain/types.js';
import { logKey } from '../domain/ids.js';
import type { ObservedBlock } from '../indexer/reorg.js';
import type { Candle } from '../market/aggregate.js';
import type { Database } from './client.js';
import { candles, launches, observedBlocks, rawLogs, sources, trades, venues } from './schema.js';

export interface SourceRegistration {
  id: string;
  chainId: number;
  version: string;
  factoryAddress: Address;
  startBlock: bigint;
}

export interface IndexedSource extends SourceCursor {
  version: string;
  factoryAddress: Address;
  startBlock: bigint;
}

export function createRepository(db: Database) {
  return {
    async registerSource(source: SourceRegistration): Promise<void> {
      await db.insert(sources).values({
        id: source.id,
        chainId: source.chainId,
        version: source.version,
        factoryAddress: source.factoryAddress.toLowerCase(),
        startBlock: source.startBlock,
        scannedToBlock: source.startBlock - 1n,
        confirmedToBlock: source.startBlock - 1n,
        status: 'backfilling',
      }).onConflictDoNothing();
      const [stored] = await db.select().from(sources).where(eq(sources.id, source.id)).limit(1);
      if (
        !stored ||
        stored.chainId !== source.chainId ||
        stored.version !== source.version ||
        stored.factoryAddress !== source.factoryAddress.toLowerCase() ||
        stored.startBlock !== source.startBlock
      ) {
        throw new Error(`Source configuration conflict: ${source.id}`);
      }
    },

    async getCursor(sourceId: string): Promise<SourceCursor> {
      const [row] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
      if (!row) throw new Error(`Unknown source: ${sourceId}`);
      return {
        sourceId: row.id,
        chainId: row.chainId,
        scannedToBlock: row.scannedToBlock,
        confirmedToBlock: row.confirmedToBlock,
        status: row.status as CoverageStatus,
      };
    },

    async saveIndexBatch(sourceId: string, fromBlock: bigint, toBlock: bigint, batch: IndexBatch): Promise<void> {
      if (fromBlock > toBlock) throw new Error('Invalid block range');
      await db.transaction(async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId)).for('update');
        if (!source) throw new Error(`Unknown source: ${sourceId}`);
        const records = [...batch.rawLogs, ...batch.launches, ...batch.venues, ...batch.trades];
        if (records.some((record) => record.chainId !== source.chainId)) {
          throw new Error(`Batch chain does not match source ${sourceId}`);
        }
        if (
          batch.rawLogs.some((log) => log.sourceId !== sourceId) ||
          batch.launches.some((launch) => launch.sourceId !== sourceId) ||
          batch.venues.some((venue) => venue.sourceId !== sourceId)
        ) {
          throw new Error(`Batch source ID does not match ${sourceId}`);
        }
        if (toBlock <= source.scannedToBlock) return;
        if (fromBlock !== source.scannedToBlock + 1n) {
          throw new Error(`Non-contiguous range for ${sourceId}: expected ${source.scannedToBlock + 1n}, got ${fromBlock}`);
        }
        if (batch.rawLogs.length) {
          await tx.insert(rawLogs).values(batch.rawLogs.map((log) => ({
            id: logKey(log.chainId, log.blockHash, log.txHash, log.logIndex),
            chainId: log.chainId,
            sourceId: log.sourceId,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash.toLowerCase(),
            txHash: log.txHash.toLowerCase(),
            logIndex: log.logIndex,
            address: log.address.toLowerCase(),
            topics: log.topics.map((topic) => topic.toLowerCase()),
            data: log.data.toLowerCase(),
          }))).onConflictDoNothing();
        }
        if (batch.launches.length) {
          await tx.insert(launches).values(batch.launches.map((launch) => ({
            chainId: launch.chainId,
            tokenAddress: launch.tokenAddress.toLowerCase(),
            sourceId: launch.sourceId,
            sourceLogId: launch.sourceLogId,
            name: launch.name,
            symbol: launch.symbol,
            tokenDecimals: launch.tokenDecimals,
            platform: launch.platform,
            protocolVersion: launch.protocolVersion,
            factoryAddress: launch.factoryAddress.toLowerCase(),
            deployerAddress: launch.deployerAddress.toLowerCase(),
            launchBlock: launch.launchBlock,
            launchTxHash: launch.launchTxHash.toLowerCase(),
            quoteAssetAddress: launch.quoteAsset.address.toLowerCase(),
            quoteAssetSymbol: launch.quoteAsset.symbol,
            quoteAssetDecimals: launch.quoteAsset.decimals,
            lifecycleStatus: launch.lifecycleStatus,
          }))).onConflictDoNothing();
        }
        if (batch.venues.length) {
          await tx.insert(venues).values(batch.venues.map((venue) => ({
            id: venue.id.toLowerCase(),
            chainId: venue.chainId,
            tokenAddress: venue.tokenAddress.toLowerCase(),
            kind: venue.kind,
            ref: venue.ref.toLowerCase(),
            sourceId: venue.sourceId,
            sourceLogId: venue.sourceLogId,
            effectiveFromBlock: venue.effectiveFromBlock,
            effectiveToBlock: venue.effectiveToBlock,
            official: venue.official,
          }))).onConflictDoNothing();
        }
        if (batch.trades.length) {
          await tx.insert(trades).values(batch.trades.map((trade) => ({
            chainId: trade.chainId,
            tokenAddress: trade.tokenAddress.toLowerCase(),
            venueId: trade.venueId.toLowerCase(),
            blockNumber: trade.blockNumber,
            blockHash: trade.blockHash.toLowerCase(),
            txHash: trade.txHash.toLowerCase(),
            logIndex: trade.logIndex,
            timestamp: trade.timestamp,
            side: trade.side,
            tokenAmountRaw: trade.tokenAmountRaw.toString(),
            quoteAmountRaw: trade.quoteAmountRaw.toString(),
            quoteAssetAddress: trade.quoteAssetAddress.toLowerCase(),
            sourceEvent: trade.sourceEvent,
            sourceLogId: logKey(trade.chainId, trade.blockHash, trade.txHash, trade.logIndex),
            priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null,
            priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
          }))).onConflictDoNothing();
        }
        await tx.update(sources).set({ scannedToBlock: toBlock, confirmedToBlock: toBlock }).where(eq(sources.id, sourceId));
      });
    },

    async replaceCandles(chainId: number, tokenAddress: Address, intervalSeconds: number, projection: readonly Candle[]): Promise<void> {
      if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) throw new Error('Invalid candle interval');
      await db.transaction(async (tx) => {
        const [launch] = await tx.select().from(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, tokenAddress.toLowerCase()))).limit(1);
        if (!launch) throw new Error('Cannot project candles for an unknown launch');
        if (projection.some((candle) => candle.chainId !== chainId || candle.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()
          || candle.intervalSeconds !== intervalSeconds || candle.quoteAssetAddress.toLowerCase() !== launch.quoteAssetAddress)) {
          throw new Error('Candle projection does not match launch identity or quote asset');
        }
        await tx.delete(candles).where(and(eq(candles.chainId, chainId), eq(candles.tokenAddress, tokenAddress.toLowerCase()),
          eq(candles.intervalSeconds, intervalSeconds)));
        if (projection.length) await tx.insert(candles).values(projection.map((candle) => ({
          chainId, tokenAddress: tokenAddress.toLowerCase(), intervalSeconds, bucketStart: candle.bucketStart,
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          quoteVolumeRaw: candle.quoteVolumeRaw.toString(),
        })));
      });
    },

    async retractBlocks(chainId: number, fromBlock: bigint): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(trades).where(and(eq(trades.chainId, chainId), gte(trades.blockNumber, fromBlock)));
        await tx.delete(venues).where(and(eq(venues.chainId, chainId), gte(venues.effectiveFromBlock, fromBlock)));
        await tx.delete(launches).where(and(eq(launches.chainId, chainId), gte(launches.launchBlock, fromBlock)));
        await tx.delete(rawLogs).where(and(eq(rawLogs.chainId, chainId), gte(rawLogs.blockNumber, fromBlock)));
        await tx.delete(observedBlocks).where(and(eq(observedBlocks.chainId, chainId), gte(observedBlocks.number, fromBlock)));
        await tx.delete(candles).where(eq(candles.chainId, chainId));
        await tx.update(sources).set({
          scannedToBlock: sql`LEAST(${sources.scannedToBlock}, ${fromBlock - 1n})`,
          confirmedToBlock: sql`LEAST(${sources.confirmedToBlock}, ${fromBlock - 1n})`,
          status: 'backfilling',
        }).where(and(eq(sources.chainId, chainId), gte(sources.scannedToBlock, fromBlock)));
      });
    },

    async recordObservedBlock(chainId: number, number: bigint, hash: Hash): Promise<void> {
      await db.insert(observedBlocks).values({ chainId, number, hash: hash.toLowerCase() }).onConflictDoNothing();
    },

    async getObservedBlocks(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<ObservedBlock[]> {
      const rows = await db.select().from(observedBlocks).where(and(
        eq(observedBlocks.chainId, chainId),
        gte(observedBlocks.number, fromBlock),
        lte(observedBlocks.number, toBlock),
      )).orderBy(observedBlocks.number);
      const rawRows = await db.select({ number: rawLogs.blockNumber, hash: rawLogs.blockHash }).from(rawLogs).where(and(
        eq(rawLogs.chainId, chainId),
        gte(rawLogs.blockNumber, fromBlock),
        lte(rawLogs.blockNumber, toBlock),
      ));
      const byNumber = new Map<string, ObservedBlock>();
      for (const row of [...rows, ...rawRows]) {
        byNumber.set(row.number.toString(), { number: row.number, hash: row.hash as Hash });
      }
      return [...byNumber.values()].sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
    },

    async listPendingSources(): Promise<IndexedSource[]> {
      const rows = await db.select().from(sources).where(ne(sources.status, 'caught_up'));
      return rows.map((row) => ({
        sourceId: row.id,
        chainId: row.chainId,
        version: row.version,
        factoryAddress: row.factoryAddress as Address,
        startBlock: row.startBlock,
        scannedToBlock: row.scannedToBlock,
        confirmedToBlock: row.confirmedToBlock,
        status: row.status as CoverageStatus,
      }));
    },
  };
}
