import { bigint, boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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

export const metadataEnrichmentBudget = pgTable('metadata_enrichment_budget', {
  id: integer('id').primaryKey(),
  lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
}, (table) => [check('metadata_enrichment_budget_singleton', sql`${table.id} = 1`)]);

export const quoteUsdFeeds = pgTable('quote_usd_feeds', {
  chainId: integer('chain_id').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  feedAddress: text('feed_address').notNull(),
  aggregatorAddress: text('aggregator_address'),
  discoverySource: text('discovery_source').notNull(),
  verificationStatus: text('verification_status').notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.quoteAssetAddress] }),
  check('quote_usd_feeds_verification_status_valid', sql`${table.verificationStatus} IN ('verified', 'unverified', 'rejected')`),
]);

export const quoteUsdPriceRounds = pgTable('quote_usd_price_rounds', {
  chainId: integer('chain_id').notNull(),
  feedAddress: text('feed_address').notNull(),
  roundId: numeric('round_id', { precision: 30, scale: 0 }).notNull(),
  answerRaw: numeric('answer_raw', { precision: 78, scale: 0 }).notNull(),
  decimals: integer('decimals').notNull(),
  startedAt: integer('started_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  logIndex: integer('log_index').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.feedAddress, table.roundId] }),
  index('quote_usd_price_rounds_position_idx').on(table.chainId, table.feedAddress, table.blockNumber, table.logIndex),
]);

export const priceJobs = pgTable('price_jobs', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  jobType: text('job_type').notNull(),
  quoteAssetAddress: text('quote_asset_address'),
  feedAddress: text('feed_address'),
  rangeStart: integer('range_start'),
  rangeEnd: integer('range_end'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  leaseId: text('lease_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Postgres treats NULL as distinct from NULL in a plain unique index — every feed_resolution row
  // has feedAddress/rangeStart/rangeEnd all NULL, so a bare column-list unique index would never
  // actually dedupe two feed_resolution jobs for the same quote asset (verified empirically before
  // writing this comment). coalesce() each nullable column to a sentinel so NULL participates in
  // the uniqueness comparison like any other value.
  uniqueIndex('price_jobs_dedup_idx').on(table.chainId, table.jobType, sql`coalesce(${table.quoteAssetAddress}, '')`,
    sql`coalesce(${table.feedAddress}, '')`, sql`coalesce(${table.rangeStart}, -1)`, sql`coalesce(${table.rangeEnd}, -1)`),
  index('price_jobs_claim_idx').on(table.status, table.nextAttemptAt, table.leaseUntil),
  check('price_jobs_valid_type', sql`${table.jobType} IN ('feed_resolution', 'round_backfill')`),
  check('price_jobs_valid_status', sql`${table.status} IN ('pending', 'done', 'failed')`),
  check('price_jobs_type_shape', sql`
    (${table.jobType} = 'feed_resolution' AND ${table.quoteAssetAddress} IS NOT NULL AND ${table.feedAddress} IS NULL)
    OR (${table.jobType} = 'round_backfill' AND ${table.feedAddress} IS NOT NULL AND ${table.rangeStart} IS NOT NULL AND ${table.rangeEnd} IS NOT NULL)
  `),
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
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'set null' }),
  // Nullable: a near-realtime-synced launch (be/src/envioSync/incrementalSync.ts) persists its
  // minimal chain-derived record before a bounded enrichment job resolves these — never a placeholder
  // empty string. Existing rows written by the old synchronous-RPC sync path are unaffected.
  name: text('name'),
  symbol: text('symbol'),
  tokenDecimals: integer('token_decimals'),
  platform: text('platform').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deployerAddress: text('deployer_address').notNull(),
  launchBlock: bigint('launch_block', { mode: 'bigint' }).notNull(),
  launchBlockHash: text('launch_block_hash'),
  launchTxHash: text('launch_tx_hash').notNull(),
  launchLogIndex: integer('launch_log_index').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  // Nullable for an unresolved real ERC20 V2 pair token; never unknown for V1 (always WETH) or a V2
  // native-ETH pair, both resolved without any RPC call.
  quoteAssetSymbol: text('quote_asset_symbol'),
  quoteAssetDecimals: integer('quote_asset_decimals'),
  lifecycleStatus: text('lifecycle_status').notNull(),
  v4PoolFee: integer('v4_pool_fee'),
  v4TickSpacing: integer('v4_tick_spacing'),
  logoUri: text('logo_uri'),
  description: text('description'),
  websiteUrl: text('website_url'),
  twitterUrl: text('twitter_url'),
  launchTimestamp: bigint('launch_timestamp', { mode: 'number' }),
  logoReadState: text('logo_read_state').notNull().default('pending'),
  descriptionReadState: text('description_read_state').notNull().default('pending'),
  socialsReadState: text('socials_read_state').notNull().default('pending'),
  timestampReadState: text('timestamp_read_state').notNull().default('pending'),
  metadataRetryAt: timestamp('metadata_retry_at', { withTimezone: true }),
  metadataRetryCount: integer('metadata_retry_count').notNull().default(0),
  metadataLeaseId: text('metadata_lease_id'),
  metadataLeaseUntil: timestamp('metadata_lease_until', { withTimezone: true }),
  // Independently-paced core-identity retry (name/symbol/decimals; V1 graduation; V2 unknown quote
  // asset symbol/decimals) — shares the extended fields' lease columns (one launch is worked on by at
  // most one enrichment claim at a time) but its own read-state/retry-count/retry-at, since core
  // fields are more urgent than logo/description/socials and must not wait behind that backlog.
  coreMetadataReadState: text('core_metadata_read_state').notNull().default('pending'),
  coreMetadataRetryAt: timestamp('core_metadata_retry_at', { withTimezone: true }),
  coreMetadataRetryCount: integer('core_metadata_retry_count').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  index('launches_source_block_idx').on(table.sourceId, table.launchBlock),
  index('launches_chain_block_idx').on(table.chainId, table.launchBlock, table.launchTxHash, table.launchLogIndex),
  index('launches_metadata_due_idx').on(table.metadataRetryAt, table.launchBlock).where(sql`${table.platform} = 'pons' AND
    (${table.logoReadState} = 'pending' OR ${table.descriptionReadState} = 'pending' OR
     ${table.socialsReadState} = 'pending' OR ${table.timestampReadState} = 'pending')`),
  index('launches_core_metadata_due_idx').on(table.coreMetadataRetryAt, table.launchBlock)
    .where(sql`${table.platform} = 'pons' AND ${table.coreMetadataReadState} = 'pending'`),
  check('launches_logo_read_state_valid', sql`${table.logoReadState} IN ('pending', 'done')`),
  check('launches_description_read_state_valid', sql`${table.descriptionReadState} IN ('pending', 'done')`),
  check('launches_socials_read_state_valid', sql`${table.socialsReadState} IN ('pending', 'done')`),
  check('launches_timestamp_read_state_valid', sql`${table.timestampReadState} IN ('pending', 'done')`),
  check('launches_metadata_retry_count_valid', sql`${table.metadataRetryCount} >= 0`),
  check('launches_core_metadata_read_state_valid', sql`${table.coreMetadataReadState} IN ('pending', 'done')`),
  check('launches_core_metadata_retry_count_valid', sql`${table.coreMetadataRetryCount} >= 0`),
]);

export const launchParityReports = pgTable('launch_parity_reports', {
  sourceId: text('source_id').notNull(),
  registryVersion: integer('registry_version').notNull(),
  fromBlock: bigint('from_block', { mode: 'bigint' }).notNull(),
  toBlock: bigint('to_block', { mode: 'bigint' }).notNull(),
  fenceBlock: bigint('fence_block', { mode: 'bigint' }).notNull(),
  envioWatermark: bigint('envio_watermark', { mode: 'bigint' }).notNull(),
  appWatermark: bigint('app_watermark', { mode: 'bigint' }).notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull(),
  chainCount: integer('chain_count').notNull(),
  envioCount: integer('envio_count').notNull(),
  appCount: integer('app_count').notNull(),
  firstBlock: bigint('first_block', { mode: 'bigint' }),
  lastBlock: bigint('last_block', { mode: 'bigint' }),
  details: jsonb('details').notNull(),
  auditedAt: timestamp('audited_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sourceId, table.fromBlock, table.toBlock, table.fenceBlock] }),
  index('launch_parity_reports_latest_idx').on(table.sourceId, table.auditedAt),
  check('launch_parity_reports_status_valid', sql`${table.status} IN ('complete', 'mismatch', 'pending')`),
]);

export const launchParityRepairs = pgTable('launch_parity_repairs', {
  sourceId: text('source_id').notNull(),
  fromBlock: bigint('from_block', { mode: 'bigint' }).notNull(),
  toBlock: bigint('to_block', { mode: 'bigint' }).notNull(),
  failureLayer: text('failure_layer').notNull(),
  action: text('action').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sourceId, table.fromBlock, table.toBlock, table.failureLayer] }),
  index('launch_parity_repairs_pending_idx').on(table.status, table.createdAt),
  check('launch_parity_repairs_layer_valid', sql`${table.failureLayer} IN ('envio', 'app')`),
  check('launch_parity_repairs_action_valid', sql`${table.action} IN ('envio_reindex', 'app_promotion')`),
  check('launch_parity_repairs_status_valid', sql`${table.status} IN ('pending', 'done')`),
]);

export const launchVolume24hUsd = pgTable('launch_volume24h_usd', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  volumeUsd: numeric('volume_usd', { precision: 78, scale: 30 }),
  rankCategory: text('rank_category').notNull(),
  rankOrder: smallint('rank_order').notNull(),
  completenessReason: text('completeness_reason').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  windowEnd: bigint('window_end', { mode: 'bigint' }).notNull(),
  nextExpiryAt: timestamp('next_expiry_at', { withTimezone: true }),
  revision: integer('revision').notNull(),
  launchBlock: bigint('launch_block', { mode: 'bigint' }).notNull(),
  launchTxHash: text('launch_tx_hash').notNull(),
  launchLogIndex: integer('launch_log_index').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('launch_volume24h_usd_rank_idx').on(table.rankOrder, table.volumeUsd.desc(), table.launchBlock.desc(),
    table.launchTxHash.desc(), table.launchLogIndex.desc()),
  check('launch_volume24h_usd_rank_valid', sql`
    (${table.rankCategory} = 'positive' AND ${table.rankOrder} = 0 AND ${table.volumeUsd} > 0 AND ${table.completenessReason} = 'complete')
    OR (${table.rankCategory} = 'zero' AND ${table.rankOrder} = 1 AND ${table.volumeUsd} = 0 AND ${table.completenessReason} = 'complete')
    OR (${table.rankCategory} = 'null' AND ${table.rankOrder} = 2 AND ${table.volumeUsd} IS NULL)
  `),
  check('launch_volume24h_usd_reason_valid', sql`${table.completenessReason} IN ('complete', 'incomplete_coverage', 'unpriced_trade', 'updating')`),
]);

export const launchStats = pgTable('launch_stats', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
]);

// Checkpoint for replaying Pons V2 bonding-curve reserves from each curve trade's own amounts
// (be/src/launchpads/pons/v2/curve.ts) — see be/src/market/curvePricing.ts. Deleting a launch's row
// is always safe: the next worker tick re-derives it from totalSupply() and a full current replay.
export const launchCurveReserves = pgTable('launch_curve_reserves', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  quoteReserveRaw: numeric('quote_reserve_raw', { precision: 78, scale: 0 }).notNull(),
  tokenReserveRaw: numeric('token_reserve_raw', { precision: 78, scale: 0 }).notNull(),
  lastBlockNumber: bigint('last_block_number', { mode: 'bigint' }).notNull(),
  lastLogIndex: integer('last_log_index').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
]);

export const usdCandles = pgTable('usd_candles', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  intervalSeconds: integer('interval_seconds').notNull(),
  bucketStart: bigint('bucket_start', { mode: 'number' }).notNull(),
  open: numeric('open', { precision: 40, scale: 20 }).notNull(),
  high: numeric('high', { precision: 40, scale: 20 }).notNull(),
  low: numeric('low', { precision: 40, scale: 20 }).notNull(),
  close: numeric('close', { precision: 40, scale: 20 }).notNull(),
  volumeUsd: numeric('volume_usd', { precision: 40, scale: 6 }).notNull(),
  tradeCount: integer('trade_count').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress, table.intervalSeconds, table.bucketStart] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  check('usd_candles_interval_valid', sql`${table.intervalSeconds} IN (60, 300, 900, 3600, 86400)`),
]);

export const launchVolume24hState = pgTable('launch_volume24h_state', {
  id: integer('id').primaryKey(),
  backfillCompleteAt: timestamp('backfill_complete_at', { withTimezone: true }),
  workerHeartbeatAt: timestamp('worker_heartbeat_at', { withTimezone: true }),
}, (table) => [check('launch_volume24h_state_singleton', sql`${table.id} = 1`)]);

export const launchVolume24hJobs = pgTable('launch_volume24h_jobs', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  revision: integer('revision').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  leaseId: text('lease_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('launch_volume24h_jobs_due_idx').on(table.dueAt, table.leaseUntil),
  check('launch_volume24h_jobs_revision_positive', sql`${table.revision} >= 1`),
  check('launch_volume24h_jobs_attempts_valid', sql`${table.attempts} >= 0`),
]);

export const venues = pgTable('venues', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'set null' }),
  effectiveFromBlock: bigint('effective_from_block', { mode: 'bigint' }).notNull(),
  effectiveFromLogIndex: integer('effective_from_log_index').notNull().default(0),
  effectiveToBlock: bigint('effective_to_block', { mode: 'bigint' }),
  effectiveToLogIndex: integer('effective_to_log_index'),
  official: boolean('official').notNull(),
}, (table) => [
  foreignKey({ columns: [table.chainId, table.tokenAddress], foreignColumns: [launches.chainId, launches.tokenAddress] }).onDelete('cascade'),
  index('venues_token_idx').on(table.chainId, table.tokenAddress),
  // be/src/envioSync/incrementalSync.ts's lookupVenue: a trade/swap page row resolves its venue by
  // (chainId, kind, ref) — pool/curve address or V4 Pool ID — not by token, once per applied row.
  index('venues_kind_ref_idx').on(table.chainId, table.kind, table.ref),
]);

export const poolCatalog = pgTable('pool_catalog', {
  chainId: integer('chain_id').notNull(),
  protocol: text('protocol').notNull(),
  poolId: text('pool_id').notNull(),
  currency0: text('currency0').notNull(),
  currency1: text('currency1').notNull(),
  fee: integer('fee').notNull(),
  tickSpacing: integer('tick_spacing').notNull(),
  hooks: text('hooks').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  verified: boolean('verified').notNull(),
  coverageStatus: text('coverage_status').notNull().default('backfilling'),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.protocol, table.poolId] }),
  check('pool_catalog_protocol', sql`${table.protocol} IN ('uniswap_v4', 'uniswap_v3', 'uniswap_v2')`),
  check('pool_catalog_verified', sql`${table.verified} = true`),
  check('pool_catalog_currency_order', sql`${table.currency0} < ${table.currency1}`),
  check('pool_catalog_coverage_status', sql`${table.coverageStatus} IN ('backfilling', 'caught_up', 'incomplete')`),
  index('pool_catalog_recent_idx').on(table.blockNumber, table.logIndex, table.chainId, table.protocol, table.poolId),
]);

export const poolSourceAudits = pgTable('pool_source_audits', {
  chainId: integer('chain_id').notNull(),
  protocol: text('protocol').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deploymentBlock: bigint('deployment_block', { mode: 'bigint' }).notNull(),
  auditedToBlock: bigint('audited_to_block', { mode: 'bigint' }),
  status: text('status').notNull().default('pending'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.protocol] }),
  check('pool_source_audits_status', sql`${table.status} IN ('pending', 'mismatch', 'complete')`),
]);

export const poolMembers = pgTable('pool_members', {
  chainId: integer('chain_id').notNull(),
  protocol: text('protocol').notNull(),
  poolId: text('pool_id').notNull(),
  tokenAddress: text('token_address').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.protocol, table.poolId, table.tokenAddress] }),
  foreignKey({ columns: [table.chainId, table.protocol, table.poolId],
    foreignColumns: [poolCatalog.chainId, poolCatalog.protocol, poolCatalog.poolId] }).onDelete('cascade'),
  index('pool_members_token_idx').on(table.chainId, table.tokenAddress),
]);

export const poolTrades = pgTable('pool_trades', {
  chainId: integer('chain_id').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  protocol: text('protocol').notNull(),
  poolId: text('pool_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  timestamp: integer('timestamp').notNull(),
  amount0Raw: numeric('amount0_raw', { precision: 78, scale: 0 }).notNull(),
  amount1Raw: numeric('amount1_raw', { precision: 78, scale: 0 }).notNull(),
  sqrtPriceX96: numeric('sqrt_price_x96', { precision: 78, scale: 0 }).notNull(),
  traderAddress: text('trader_address').notNull(),
  senderAddress: text('sender_address').notNull(),
  fee: integer('fee').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
  foreignKey({ columns: [table.chainId, table.protocol, table.poolId],
    foreignColumns: [poolCatalog.chainId, poolCatalog.protocol, poolCatalog.poolId] }).onDelete('cascade'),
  index('pool_trades_pool_time_idx').on(table.chainId, table.protocol, table.poolId, table.timestamp),
  index('pool_trades_pool_block_idx').on(table.chainId, table.protocol, table.poolId, table.blockNumber),
]);

export const poolSyncCursors = pgTable('pool_sync_cursors', {
  chainId: integer('chain_id').notNull(),
  stream: text('stream').notNull(),
  lane: text('lane').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull().default(sql`0`),
  logIndex: integer('log_index').notNull().default(-1),
  rawId: text('raw_id').notNull().default(''),
  processedWatermark: bigint('processed_watermark', { mode: 'bigint' }),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.stream, table.lane] }),
  check('pool_sync_cursors_stream', sql`${table.stream} IN ('initialize', 'swap', 'v3_created', 'v3_swap', 'v2_created', 'v2_swap')`),
  check('pool_sync_cursors_lane', sql`${table.lane} IN ('tail', 'history')`),
]);

export const poolPendingSwaps = pgTable('pool_pending_swaps', {
  chainId: integer('chain_id').notNull(),
  rawId: text('raw_id').notNull(),
  protocol: text('protocol').notNull().default('uniswap_v4'),
  poolId: text('pool_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.rawId] }),
  index('pool_pending_swaps_pool_idx').on(table.chainId, table.poolId),
]);

export const poolCandleDirtyBuckets = pgTable('pool_candle_dirty_buckets', {
  chainId: integer('chain_id').notNull(),
  protocol: text('protocol').notNull(),
  poolId: text('pool_id').notNull(),
  bucketStart: integer('bucket_start').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.protocol, table.poolId, table.bucketStart] }),
  index('pool_candle_dirty_oldest_idx').on(table.bucketStart),
]);

export const poolCandles = pgTable('pool_candles', {
  chainId: integer('chain_id').notNull(),
  protocol: text('protocol').notNull(),
  poolId: text('pool_id').notNull(),
  intervalSeconds: integer('interval_seconds').notNull(),
  bucketStart: integer('bucket_start').notNull(),
  openSqrtPriceX96: numeric('open_sqrt_price_x96', { precision: 78, scale: 0 }).notNull(),
  highSqrtPriceX96: numeric('high_sqrt_price_x96', { precision: 78, scale: 0 }).notNull(),
  lowSqrtPriceX96: numeric('low_sqrt_price_x96', { precision: 78, scale: 0 }).notNull(),
  closeSqrtPriceX96: numeric('close_sqrt_price_x96', { precision: 78, scale: 0 }).notNull(),
  tradeCount: integer('trade_count').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.protocol, table.poolId, table.intervalSeconds, table.bucketStart] }),
  foreignKey({ columns: [table.chainId, table.protocol, table.poolId],
    foreignColumns: [poolCatalog.chainId, poolCatalog.protocol, poolCatalog.poolId] }).onDelete('cascade'),
]);

export const lifecycleTransitions = pgTable('lifecycle_transitions', {
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'set null' }),
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
  primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
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
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'set null' }),
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

// The Envio sync layer's own view of the chain head (from Envio's chain_metadata.block_height),
// written once per real-table sync cycle. Separate from observed_blocks (which only the RPC-scan
// indexer writes, keyed by real block hash, for its own reorg bookkeeping) — reusing that table for
// this would either fake a hash (risking corrupting its real reorg-detection reads) or grow one row
// per cycle forever. be/src/api/store.ts's safeHead()/coverage() take the max of both sources, so
// coverage stays honest once the RPC-scan indexer stops advancing observed_blocks (final review,
// Important 3 on docs/superpowers/plans/2026-10-01-envio-cutover-implementation.md).
export const envioChainProgress = pgTable('envio_chain_progress', {
  chainId: integer('chain_id').primaryKey(),
  headBlock: bigint('head_block', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Durable per-(chain, Envio raw stream, lane) read position for the incremental near-realtime sync
// (be/src/envioSync/incrementalCursor.ts). "tail" starts near Envio's current head for fresh activity,
// "history" resumes the earliest unsynced block — see docs/superpowers/specs/2026-10-05-envio-near-realtime-sync-design.md.
// block_number/log_index/raw_id together are the last applied row's position (genesis: 0/-1/'');
// processed_watermark is the pass's own Envio fence, advanced even on an empty range so staleness is
// observable without a new row ever arriving.
export const envioSyncCursors = pgTable('envio_sync_cursors', {
  chainId: integer('chain_id').notNull(),
  stream: text('stream').notNull(),
  lane: text('lane').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  logIndex: integer('log_index').notNull(),
  rawId: text('raw_id').notNull(),
  processedWatermark: bigint('processed_watermark', { mode: 'bigint' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.stream, table.lane] }),
  check('envio_sync_cursors_valid_stream', sql`${table.stream} IN
    ('v1-launch', 'v1-swap', 'v2-launch', 'v2-curve', 'v2-buyback', 'v2-lifecycle', 'v4-initialize', 'v4-swap')`),
  check('envio_sync_cursors_valid_lane', sql`${table.lane} IN ('tail', 'history')`),
]);

// A raw-event key an incremental sync pass (be/src/envioSync/incrementalSync.ts) saw but could not
// apply because its launch/venue dependency wasn't in the app DB yet (e.g. a swap arriving before its
// launch). The stream's own raw-read cursor keeps advancing past it — this table is the durable record
// that lets be/src/envioSync/unresolvedEvents.ts retry it later, independent of cursor position.
export const unresolvedEvents = pgTable('unresolved_events', {
  chainId: integer('chain_id').notNull(),
  stream: text('stream').notNull(),
  rawId: text('raw_id').notNull(),
  reason: text('reason').notNull(),
  // The row's own block — be/src/envioSync/incrementalSync.ts's confirmedSourceBlock caps a stream's
  // confirmed-contiguous watermark just before the earliest still-unresolved block, so coverage can
  // never claim complete past a gap this stream's cursor merely read past without actually applying.
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.stream, table.rawId] }),
  index('unresolved_events_due_idx').on(table.nextRetryAt),
  index('unresolved_events_block_idx').on(table.chainId, table.stream, table.blockNumber),
  check('unresolved_events_valid_stream', sql`${table.stream} IN
    ('v1-launch', 'v1-swap', 'v2-launch', 'v2-curve', 'v2-buyback', 'v2-lifecycle', 'v4-initialize', 'v4-swap')`),
  check('unresolved_events_retry_count_valid', sql`${table.retryCount} >= 0`),
]);

// Tracks whether be/src/envioSync/incrementalRepair.ts's bounded repair pass is actually succeeding —
// a repair failure must be observable from the coverage API, not only from CLI logs.
export const envioRepairState = pgTable('envio_repair_state', {
  chainId: integer('chain_id').primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastFailureReason: text('last_failure_reason'),
  failureCount: integer('failure_count').notNull().default(0),
});

export const candleDirtyBuckets = pgTable('candle_dirty_buckets', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  bucketStart: integer('bucket_start').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress, table.bucketStart] }),
  index('candle_dirty_buckets_oldest_idx').on(table.bucketStart),
]);

export const candleUnpricedBuckets = pgTable('candle_unpriced_buckets', {
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  bucketStart: integer('bucket_start').notNull(),
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress, table.bucketStart] }),
]);

export const candleCacheState = pgTable('candle_cache_state', {
  id: integer('id').primaryKey(),
  backfillComplete: boolean('backfill_complete').notNull().default(false),
  nextTimestamp: integer('next_timestamp'),
}, (table) => [check('candle_cache_state_singleton', sql`${table.id} = 1`)]);

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
  // Both nullable: known for free only when the quote asset is native ETH (the zero address) — see
  // envioSync/transformV2.ts's resolveKnownQuoteAsset. Any real ERC20 pair token's symbol/decimals
  // are genuinely unknown without a metadata RPC call this phase doesn't make (found live: real V2
  // launches quote in tokens with decimals other than 18 — faking 18 would silently corrupt volume).
  quoteAssetSymbol: text('quote_asset_symbol'),
  quoteAssetDecimals: integer('quote_asset_decimals'),
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

export const lifecycleTransitionsEnvioStaging = pgTable('lifecycle_transitions_envio_staging', {
  sourceLogId: text('source_log_id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  phase: integer('phase').notNull(),
  kind: text('kind').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
});
