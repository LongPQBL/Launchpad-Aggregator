import { bigint, boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  version: text('version').notNull(),
  factoryAddress: text('factory_address').notNull(),
  startBlock: bigint('start_block', { mode: 'bigint' }).notNull(),
  scannedToBlock: bigint('scanned_to_block', { mode: 'bigint' }).notNull(),
  confirmedToBlock: bigint('confirmed_to_block', { mode: 'bigint' }).notNull(),
  status: text('status').notNull(),
});

export const sourceGaps = pgTable('source_gaps', {
  sourceId: text('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  fromBlock: bigint('from_block', { mode: 'bigint' }).notNull(),
  toBlock: bigint('to_block', { mode: 'bigint' }).notNull(),
  reason: text('reason').notNull(),
}, (table) => [primaryKey({ columns: [table.sourceId, table.fromBlock, table.toBlock] })]);

export const scanJobs = pgTable('scan_jobs', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  lane: text('lane').notNull(),
  fromBlock: bigint('from_block', { mode: 'bigint' }).notNull(),
  toBlock: bigint('to_block', { mode: 'bigint' }).notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull().default(sql`0`),
  status: text('status').notNull(),
  leaseOwner: text('lease_owner'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  elapsedMs: integer('elapsed_ms'),
  requestCount: integer('request_count'),
  errorReason: text('error_reason'),
}, (table) => [
  uniqueIndex('scan_jobs_source_lane_range').on(table.sourceId, table.lane, table.fromBlock, table.toBlock),
  index('scan_jobs_claim_idx').on(table.status, table.leaseUntil, table.sourceId),
  check('scan_jobs_valid_range', sql`${table.fromBlock} <= ${table.toBlock}`),
  check('scan_jobs_valid_lane', sql`${table.lane} IN ('certified', 'provisional')`),
]);

export const rawLogs = pgTable('raw_logs', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  address: text('address').notNull(),
  topics: jsonb('topics').$type<readonly string[]>().notNull(),
  data: text('data').notNull(),
}, (table) => [
  uniqueIndex('raw_logs_chain_block_tx_log_idx').on(table.chainId, table.blockHash, table.txHash, table.logIndex),
  index('raw_logs_source_block_idx').on(table.sourceId, table.blockNumber),
]);

export const launches = pgTable('launches', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  sourceLogId: text('source_log_id').notNull().references(() => rawLogs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  symbol: text('symbol').notNull(),
  tokenDecimals: integer('token_decimals').notNull(),
  platform: text('platform').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deployerAddress: text('deployer_address').notNull(),
  launchBlock: bigint('launch_block', { mode: 'bigint' }).notNull(),
  launchTxHash: text('launch_tx_hash').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  quoteAssetSymbol: text('quote_asset_symbol').notNull(),
  quoteAssetDecimals: integer('quote_asset_decimals').notNull(),
  lifecycleStatus: text('lifecycle_status').notNull(),
  v4PoolFee: integer('v4_pool_fee'),
  v4TickSpacing: integer('v4_tick_spacing'),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  index('launches_source_block_idx').on(table.sourceId, table.launchBlock),
]);

export const venues = pgTable('venues', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  sourceLogId: text('source_log_id').notNull().references(() => rawLogs.id, { onDelete: 'cascade' }),
  effectiveFromBlock: bigint('effective_from_block', { mode: 'bigint' }).notNull(),
  effectiveFromLogIndex: integer('effective_from_log_index').notNull().default(0),
  effectiveToBlock: bigint('effective_to_block', { mode: 'bigint' }),
  effectiveToLogIndex: integer('effective_to_log_index'),
  official: boolean('official').notNull(),
}, (table) => [
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('venues_token_idx').on(table.chainId, table.tokenAddress),
]);

export const lifecycleTransitions = pgTable('lifecycle_transitions', {
  sourceLogId: text('source_log_id').primaryKey().references(() => rawLogs.id, { onDelete: 'cascade' }),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  phase: integer('phase').notNull(),
  kind: text('kind').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
}, (table) => [
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('lifecycle_transitions_token_position_idx').on(table.chainId, table.tokenAddress, table.blockNumber, table.logIndex),
]);

export const phaseObservations = pgTable('phase_observations', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  status: text('status').notNull(),
  observedPhase: integer('observed_phase'),
  reason: text('reason'),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
]);

export const trades = pgTable('trades', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  venueId: text('venue_id').notNull().references(() => venues.id, { onDelete: 'cascade' }),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  timestamp: integer('timestamp').notNull(),
  side: text('side').notNull(),
  tokenAmountRaw: numeric('token_amount_raw', { precision: 78, scale: 0 }).notNull(),
  quoteAmountRaw: numeric('quote_amount_raw', { precision: 78, scale: 0 }).notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  sourceEvent: text('source_event').notNull(),
  activityKind: text('activity_kind').notNull().default('user_trade'),
  sourceLogId: text('source_log_id').notNull().references(() => rawLogs.id, { onDelete: 'cascade' }),
  priceNumeratorRaw: text('price_numerator_raw'),
  priceDenominatorRaw: text('price_denominator_raw'),
  // Nullable only because rows saved before this field existed haven't been backfilled yet
  // (see be/src/cli/backfillTraderAddress.ts) — every row decoded by current code populates it.
  traderAddress: text('trader_address'),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
  index('trades_token_block_idx').on(table.chainId, table.tokenAddress, table.blockNumber),
  index('trades_token_timestamp_idx').on(table.chainId, table.tokenAddress, table.timestamp),
  index('trades_trader_idx').on(table.chainId, table.traderAddress),
]);

export const candles = pgTable('candles', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  intervalSeconds: integer('interval_seconds').notNull(),
  bucketStart: integer('bucket_start').notNull(),
  open: text('open').notNull(),
  high: text('high').notNull(),
  low: text('low').notNull(),
  close: text('close').notNull(),
  quoteVolumeRaw: numeric('quote_volume_raw', { precision: 78, scale: 0 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress, table.intervalSeconds, table.bucketStart] }),
]);

export const observedBlocks = pgTable('observed_blocks', {
  chainId: integer('chain_id').notNull(),
  number: bigint('number', { mode: 'bigint' }).notNull(),
  hash: text('hash').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.number] }),
]);

// Isolated shadow copies of launches/venues/trades, written only by the Envio sync layer
// (be/src/envioSync/) during the Phase 1 parallel-run slice — never read by the real API, no
// foreign keys to the real tables. See docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md.
export const launchesEnvioStaging = pgTable('launches_envio_staging', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  // name/symbol/lifecycleStatus are nullable: Phase 1's sync layer has no on-chain metadata/graduation
  // RPC call (deliberately out of scope — see the comment in envioSync/runSync.ts), so these are
  // genuinely unknown rather than defaulted to a plausible-looking fake value (CLAUDE.md: null means
  // unavailable, never silently faked).
  name: text('name'),
  symbol: text('symbol'),
  tokenDecimals: integer('token_decimals').notNull(),
  platform: text('platform').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deployerAddress: text('deployer_address').notNull(),
  launchBlock: bigint('launch_block', { mode: 'bigint' }).notNull(),
  launchTxHash: text('launch_tx_hash').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  quoteAssetSymbol: text('quote_asset_symbol').notNull(),
  quoteAssetDecimals: integer('quote_asset_decimals').notNull(),
  lifecycleStatus: text('lifecycle_status'),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
]);

export const venuesEnvioStaging = pgTable('venues_envio_staging', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  effectiveFromBlock: bigint('effective_from_block', { mode: 'bigint' }).notNull(),
  official: boolean('official').notNull(),
});

export const tradesEnvioStaging = pgTable('trades_envio_staging', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  venueId: text('venue_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  // Provenance kept for future reorg-handling (spec section 5 keys on (chainId, blockHash, txHash,
  // logIndex)); the actual reorg-delete-stale-rows logic is deferred to the parallel-run plan.
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  timestamp: integer('timestamp').notNull(),
  side: text('side').notNull(),
  tokenAmountRaw: numeric('token_amount_raw', { precision: 78, scale: 0 }).notNull(),
  quoteAmountRaw: numeric('quote_amount_raw', { precision: 78, scale: 0 }).notNull(),
  activityKind: text('activity_kind').notNull(),
  priceNumeratorRaw: text('price_numerator_raw'),
  priceDenominatorRaw: text('price_denominator_raw'),
  traderAddress: text('trader_address').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
]);
