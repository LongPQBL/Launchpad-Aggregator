import { bigint, boolean, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

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
  effectiveToBlock: bigint('effective_to_block', { mode: 'bigint' }),
  official: boolean('official').notNull(),
}, (table) => [
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('venues_token_idx').on(table.chainId, table.tokenAddress),
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
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
  index('trades_token_block_idx').on(table.chainId, table.tokenAddress, table.blockNumber),
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
