import type { Pool } from 'pg';
import type { Address, Hash } from 'viem';
import type { Launch, LifecycleStatus, ProtocolVersion, Venue, VenueKind } from '../domain/types.js';

export interface VenueContext { launch: Launch; venue: Venue }

export function createVenueStore(pool: Pool) {
  return {
    async listOfficial(kind: VenueKind, chainId: number): Promise<VenueContext[]> {
      const result = await pool.query(`SELECT l.*, v.id AS venue_id, v.kind AS venue_kind, v.ref AS venue_ref,
        v.source_id AS venue_source_id, v.source_log_id AS venue_source_log_id,
        v.effective_from_block, v.effective_from_log_index, v.effective_to_block, v.effective_to_log_index
        FROM venues v JOIN launches l ON l.chain_id = v.chain_id AND l.token_address = v.token_address
        WHERE v.chain_id = $1 AND v.kind = $2 AND v.official = true ORDER BY v.effective_from_block, v.id`, [chainId, kind]);
      return result.rows.map((row) => {
        const launch: Launch = {
          chainId: row.chain_id, tokenAddress: row.token_address as Address, name: row.name, symbol: row.symbol,
          tokenDecimals: row.token_decimals, platform: 'pons', protocolVersion: row.protocol_version as ProtocolVersion,
          sourceId: row.source_id, sourceLogId: row.source_log_id, factoryAddress: row.factory_address as Address,
          deployerAddress: row.deployer_address as Address, launchBlock: BigInt(row.launch_block),
          launchTxHash: row.launch_tx_hash as Hash,
          quoteAsset: { address: row.quote_asset_address as Address, symbol: row.quote_asset_symbol, decimals: row.quote_asset_decimals },
          lifecycleStatus: row.lifecycle_status as LifecycleStatus,
          v4PoolFee: row.v4_pool_fee, v4TickSpacing: row.v4_tick_spacing,
        };
        const venue: Venue = {
          id: row.venue_id, chainId: row.chain_id, tokenAddress: row.token_address as Address, kind: row.venue_kind as VenueKind,
          ref: row.venue_ref, sourceId: row.venue_source_id, sourceLogId: row.venue_source_log_id,
          effectiveFromBlock: BigInt(row.effective_from_block),
          effectiveFromLogIndex: row.effective_from_log_index,
          effectiveToBlock: row.effective_to_block === null ? null : BigInt(row.effective_to_block),
          effectiveToLogIndex: row.effective_to_log_index, official: true,
        };
        return { launch, venue };
      });
    },
  };
}
