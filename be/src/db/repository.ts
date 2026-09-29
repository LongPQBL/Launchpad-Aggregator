import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Address, Hash } from 'viem';
import type { CoverageStatus, IndexBatch, SourceCursor } from '../domain/types.js';
import { logKey } from '../domain/ids.js';
import type { ObservedBlock } from '../indexer/reorg.js';
import type { ScanReport } from '../indexer/scan.js';
import type { Candle } from '../market/aggregate.js';
import type { Database } from './client.js';
import { candles, launches, lifecycleTransitions, observedBlocks, rawLogs, sourceGaps, sources, trades, venues } from './schema.js';

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
    async setV2PoolTerms(chainId: number, tokenAddress: Address, fee: number, tickSpacing: number): Promise<void> {
      if (fee !== 0 || !Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 32767) {
        throw new Error('Invalid Pons V2 pool terms');
      }
      await db.transaction(async (tx) => {
        const [launch] = await tx.select().from(launches).where(and(eq(launches.chainId, chainId),
          eq(launches.tokenAddress, tokenAddress.toLowerCase()))).for('update');
        if (!launch || launch.protocolVersion !== 'v2') throw new Error('Unknown Pons V2 launch');
        if ((launch.v4PoolFee !== null && launch.v4PoolFee !== fee)
          || (launch.v4TickSpacing !== null && launch.v4TickSpacing !== tickSpacing)) {
          throw new Error('Pons V2 pool terms conflict');
        }
        await tx.update(launches).set({ v4PoolFee: fee, v4TickSpacing: tickSpacing }).where(and(
          eq(launches.chainId, chainId), eq(launches.tokenAddress, tokenAddress.toLowerCase()),
        ));
      });
    },
    async recordScanReport(report: ScanReport): Promise<void> {
      type Gap = { fromBlock: bigint; toBlock: bigint; reason: string };
      const subtract = (gaps: Gap[], fromBlock: bigint, toBlock: bigint): Gap[] => gaps.flatMap((gap) => {
        if (toBlock < gap.fromBlock || fromBlock > gap.toBlock) return [gap];
        return [
          ...(gap.fromBlock < fromBlock ? [{ ...gap, toBlock: fromBlock - 1n }] : []),
          ...(gap.toBlock > toBlock ? [{ ...gap, fromBlock: toBlock + 1n }] : []),
        ];
      });
      await db.transaction(async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.id, report.sourceId)).for('update');
        if (!source) throw new Error(`Unknown source: ${report.sourceId}`);
        let gaps: Gap[] = (await tx.select().from(sourceGaps).where(eq(sourceGaps.sourceId, report.sourceId)))
          .map((row) => ({ fromBlock: row.fromBlock, toBlock: row.toBlock, reason: row.reason }));
        for (const range of report.committedRanges) {
          if (range.fromBlock > range.toBlock) throw new Error('Invalid committed range');
          gaps = subtract(gaps, range.fromBlock, range.toBlock);
        }
        for (const range of report.missingRanges) {
          if (range.fromBlock > range.toBlock) throw new Error('Invalid missing range');
          gaps = subtract(gaps, range.fromBlock, range.toBlock);
          gaps.push({ fromBlock: range.fromBlock, toBlock: range.toBlock, reason: range.reason });
        }
        await tx.delete(sourceGaps).where(eq(sourceGaps.sourceId, report.sourceId));
        if (gaps.length) await tx.insert(sourceGaps).values(gaps.map((gap) => ({ ...gap, sourceId: report.sourceId })));
        if (report.missingRanges.length) await tx.update(sources).set({ status: 'degraded' }).where(eq(sources.id, report.sourceId));
      });
    },
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

    async setSourceStatus(sourceId: string, status: CoverageStatus, safeHead: bigint): Promise<void> {
      await db.transaction(async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId)).for('update');
        if (!source) throw new Error(`Unknown source: ${sourceId}`);
        if (status === 'caught_up' && source.confirmedToBlock < safeHead && source.startBlock <= safeHead) {
          throw new Error(`Source checkpoint is behind safe head: ${sourceId}`);
        }
        await tx.update(sources).set({ status }).where(eq(sources.id, sourceId));
        await tx.execute(sql`SELECT pg_notify('launchpad_events', ${JSON.stringify({ type: 'coverage.changed', chainId: source.chainId })})`);
      });
    },

    async saveIndexBatch(sourceId: string, fromBlock: bigint, toBlock: bigint, batch: IndexBatch): Promise<void> {
      if (fromBlock > toBlock) throw new Error('Invalid block range');
      await db.transaction(async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId)).for('update');
        if (!source) throw new Error(`Unknown source: ${sourceId}`);
        const records = [...batch.rawLogs, ...batch.launches, ...batch.venues, ...batch.trades, ...batch.transitions];
        if (records.some((record) => record.chainId !== source.chainId)) {
          throw new Error(`Batch chain does not match source ${sourceId}`);
        }
        if (
          batch.rawLogs.some((log) => log.sourceId !== sourceId) ||
          batch.launches.some((launch) => launch.sourceId !== sourceId) ||
          batch.venues.some((venue) => venue.sourceId !== sourceId) ||
          batch.transitions.some((transition) => transition.sourceId !== sourceId)
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
            v4PoolFee: launch.v4PoolFee ?? null,
            v4TickSpacing: launch.v4TickSpacing ?? null,
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
            effectiveFromLogIndex: venue.effectiveFromLogIndex ?? 0,
            effectiveToBlock: venue.effectiveToBlock,
            effectiveToLogIndex: venue.effectiveToLogIndex ?? null,
            official: venue.official,
          }))).onConflictDoNothing();
        }
        if (batch.trades.length) {
          const ids = [...new Set(batch.trades.map((trade) => trade.venueId.toLowerCase()))];
          const venueRows = await tx.select().from(venues).where(inArray(venues.id, ids));
          const byId = new Map(venueRows.map((venue) => [venue.id, venue]));
          for (const trade of batch.trades) {
            const venue = byId.get(trade.venueId.toLowerCase());
            if (!venue || venue.chainId !== trade.chainId || venue.tokenAddress !== trade.tokenAddress.toLowerCase()
              || trade.blockNumber < venue.effectiveFromBlock
              || (trade.blockNumber === venue.effectiveFromBlock && trade.logIndex < venue.effectiveFromLogIndex)
              || (venue.effectiveToBlock !== null && (trade.blockNumber > venue.effectiveToBlock
                || (trade.blockNumber === venue.effectiveToBlock && trade.logIndex >= (venue.effectiveToLogIndex ?? 0))))) {
              throw new Error('Trade is outside official venue position');
            }
          }
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
            activityKind: trade.activityKind,
            sourceLogId: logKey(trade.chainId, trade.blockHash, trade.txHash, trade.logIndex),
            priceNumeratorRaw: trade.priceNumeratorRaw?.toString() ?? null,
            priceDenominatorRaw: trade.priceDenominatorRaw?.toString() ?? null,
          }))).onConflictDoNothing();
        }
        if (batch.transitions.length) {
          const logsById = new Map(batch.rawLogs.map((log) => [logKey(log.chainId, log.blockHash, log.txHash, log.logIndex), log]));
          for (const transition of batch.transitions) {
            const log = logsById.get(transition.sourceLogId);
            if (!log || log.chainId !== transition.chainId || log.sourceId !== transition.sourceId
              || log.blockNumber !== transition.blockNumber || log.blockHash.toLowerCase() !== transition.blockHash.toLowerCase()
              || log.txHash.toLowerCase() !== transition.txHash.toLowerCase() || log.logIndex !== transition.logIndex) {
              throw new Error('Transition does not match its source log');
            }
          }
          await tx.insert(lifecycleTransitions).values(batch.transitions.map((transition) => ({
            sourceLogId: transition.sourceLogId,
            chainId: transition.chainId,
            tokenAddress: transition.tokenAddress.toLowerCase(),
            sourceId: transition.sourceId,
            phase: transition.phase,
            kind: transition.kind,
            blockNumber: transition.blockNumber,
            blockHash: transition.blockHash.toLowerCase(),
            txHash: transition.txHash.toLowerCase(),
            logIndex: transition.logIndex,
          }))).onConflictDoNothing();
          for (const tokenAddress of new Set(batch.transitions.map((transition) => transition.tokenAddress.toLowerCase()))) {
            await tx.execute(sql`UPDATE launches AS l SET lifecycle_status = COALESCE((
              SELECT CASE t.phase WHEN 1 THEN 'swept' WHEN 2 THEN 'graduated' WHEN 3 THEN 'rescued' END
              FROM lifecycle_transitions AS t WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address
              ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1
            ), 'trading') WHERE l.chain_id = ${source.chainId} AND l.token_address = ${tokenAddress} AND l.protocol_version = 'v2'`);
            await tx.execute(sql`UPDATE venues AS v SET
              effective_to_block = (SELECT t.block_number FROM lifecycle_transitions AS t
                WHERE t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.phase = 1
                ORDER BY t.block_number, t.log_index LIMIT 1),
              effective_to_log_index = (SELECT t.log_index FROM lifecycle_transitions AS t
                WHERE t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.phase = 1
                ORDER BY t.block_number, t.log_index LIMIT 1)
              WHERE v.chain_id = ${source.chainId} AND v.token_address = ${tokenAddress} AND v.kind = 'curve'`);
          }
        }
        const repairedGaps = await tx.select().from(sourceGaps).where(and(
          eq(sourceGaps.sourceId, sourceId), lte(sourceGaps.fromBlock, toBlock), gte(sourceGaps.toBlock, fromBlock),
        ));
        for (const gap of repairedGaps) {
          await tx.delete(sourceGaps).where(and(eq(sourceGaps.sourceId, sourceId),
            eq(sourceGaps.fromBlock, gap.fromBlock), eq(sourceGaps.toBlock, gap.toBlock)));
          const remainders = [
            ...(gap.fromBlock < fromBlock ? [{ sourceId, fromBlock: gap.fromBlock, toBlock: fromBlock - 1n, reason: gap.reason }] : []),
            ...(gap.toBlock > toBlock ? [{ sourceId, fromBlock: toBlock + 1n, toBlock: gap.toBlock, reason: gap.reason }] : []),
          ];
          if (remainders.length) await tx.insert(sourceGaps).values(remainders);
        }
        await tx.update(sources).set({ scannedToBlock: toBlock, confirmedToBlock: toBlock }).where(eq(sources.id, sourceId));
        for (const tokenAddress of new Set(batch.launches.map((launch) => launch.tokenAddress.toLowerCase()))) {
          await tx.execute(sql`SELECT pg_notify('launchpad_events', ${JSON.stringify({ type: 'launch.changed', chainId: source.chainId, tokenAddress })})`);
        }
        for (const tokenAddress of new Set(batch.trades.map((trade) => trade.tokenAddress.toLowerCase()))) {
          await tx.execute(sql`SELECT pg_notify('launchpad_events', ${JSON.stringify({ type: 'trade.created', chainId: source.chainId, tokenAddress })})`);
        }
        await tx.execute(sql`SELECT pg_notify('launchpad_events', ${JSON.stringify({ type: 'coverage.changed', chainId: source.chainId })})`);
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
        const affected = await tx.select({ tokenAddress: lifecycleTransitions.tokenAddress }).from(lifecycleTransitions)
          .where(and(eq(lifecycleTransitions.chainId, chainId), gte(lifecycleTransitions.blockNumber, fromBlock)));
        await tx.delete(trades).where(and(eq(trades.chainId, chainId), gte(trades.blockNumber, fromBlock)));
        await tx.delete(venues).where(and(eq(venues.chainId, chainId), gte(venues.effectiveFromBlock, fromBlock)));
        await tx.delete(launches).where(and(eq(launches.chainId, chainId), gte(launches.launchBlock, fromBlock)));
        await tx.delete(rawLogs).where(and(eq(rawLogs.chainId, chainId), gte(rawLogs.blockNumber, fromBlock)));
        for (const tokenAddress of new Set(affected.map((row) => row.tokenAddress))) {
          await tx.execute(sql`UPDATE launches AS l SET lifecycle_status = COALESCE((
            SELECT CASE t.phase WHEN 1 THEN 'swept' WHEN 2 THEN 'graduated' WHEN 3 THEN 'rescued' END
            FROM lifecycle_transitions AS t WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address
            ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1
          ), 'trading') WHERE l.chain_id = ${chainId} AND l.token_address = ${tokenAddress} AND l.protocol_version = 'v2'`);
          await tx.execute(sql`UPDATE venues AS v SET
            effective_to_block = (SELECT t.block_number FROM lifecycle_transitions AS t
              WHERE t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.phase = 1
              ORDER BY t.block_number, t.log_index LIMIT 1),
            effective_to_log_index = (SELECT t.log_index FROM lifecycle_transitions AS t
              WHERE t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.phase = 1
              ORDER BY t.block_number, t.log_index LIMIT 1)
            WHERE v.chain_id = ${chainId} AND v.token_address = ${tokenAddress} AND v.kind = 'curve'`);
        }
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
