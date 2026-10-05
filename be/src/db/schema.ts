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
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  symbol: text('symbol').notNull(),
  tokenDecimals: integer('token_decimals').notNull(),
  platform: text('platform').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deployerAddress: text('deployer_address').notNull(),
  launchBlock: bigint('launch_block', { mode: 'bigint' }).notNull(),
  launchBlockHash: text('launch_block_hash'),
  launchTxHash: text('launch_tx_hash').notNull(),
  launchLogIndex: integer('launch_log_index').notNull(),
  quoteAssetAddress: text('quote_asset_address').notNull(),
  quoteAssetSymbol: text('quote_asset_symbol').notNull(),
  quoteAssetDecimals: integer('quote_asset_decimals').notNull(),
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
}, (table) => [
  primaryKey({ columns: [table.chainId, table.tokenAddress] }),
  index('launches_source_block_idx').on(table.sourceId, table.launchBlock),
  index('launches_chain_block_idx').on(table.chainId, table.launchBlock, table.launchTxHash, table.launchLogIndex),
  index('launches_metadata_due_idx').on(table.metadataRetryAt, table.launchBlock).where(sql`${table.platform} = 'pons' AND
    (${table.logoReadState} = 'pending' OR ${table.descriptionReadState} = 'pending' OR
     ${table.socialsReadState} = 'pending' OR ${table.timestampReadState} = 'pending')`),
  check('launches_logo_read_state_valid', sql`${table.logoReadState} IN ('pending', 'done')`),
  check('launches_description_read_state_valid', sql`${table.descriptionReadState} IN ('pending', 'done')`),
  check('launches_socials_read_state_valid', sql`${table.socialsReadState} IN ('pending', 'done')`),
  check('launches_timestamp_read_state_valid', sql`${table.timestampReadState} IN ('pending', 'done')`),
  check('launches_metadata_retry_count_valid', sql`${table.metadataRetryCount} >= 0`),
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

export const venues = pgTable('venues', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'cascade' }),
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

export const lifecycleTransitions = pgTable('lifecycle_transitions', {
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'cascade' }),
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
  sourceLogId: text('source_log_id').references(() => rawLogs.id, { onDelete: 'cascade' }),
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
