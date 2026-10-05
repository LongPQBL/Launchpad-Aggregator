import type { Pool } from 'pg';
import type { Address } from 'viem';
import { drizzle } from 'drizzle-orm/node-postgres';
import { invalidateForPriceChange } from '../launchVolume/oracleInvalidation.js';

export interface QuoteFeed {
  chainId: number;
  quoteAssetAddress: Address;
  feedAddress: Address;
  aggregatorAddress: Address | null;
  discoverySource: string;
  verificationStatus: 'verified' | 'unverified' | 'rejected';
}

export async function resolveVerifiedFeed(pool: Pool, chainId: number, quoteAssetAddress: string): Promise<QuoteFeed | null> {
  const result = await pool.query(
    `SELECT chain_id, quote_asset_address, feed_address, aggregator_address, discovery_source, verification_status
     FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2 AND verification_status = 'verified'`,
    [chainId, quoteAssetAddress.toLowerCase()],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    chainId: Number(row.chain_id), quoteAssetAddress: String(row.quote_asset_address) as Address,
    feedAddress: String(row.feed_address) as Address,
    aggregatorAddress: row.aggregator_address === null ? null : String(row.aggregator_address) as Address,
    discoverySource: String(row.discovery_source), verificationStatus: row.verification_status as QuoteFeed['verificationStatus'],
  };
}

const MAX_BLOCK = 9_223_372_036_854_775_807n;

export async function upsertQuoteFeed(pool: Pool, feed: {
  chainId: number; quoteAssetAddress: Address; feedAddress: Address; aggregatorAddress: Address | null;
  discoverySource: string; verificationStatus: 'verified' | 'rejected'; now: Date;
}): Promise<void> {
  const quoteAsset = feed.quoteAssetAddress.toLowerCase();
  const feedAddress = feed.feedAddress.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      'SELECT feed_address, verification_status FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2 FOR UPDATE',
      [feed.chainId, quoteAsset],
    );
    await client.query(
      `INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, aggregator_address, discovery_source, verification_status, last_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET
         feed_address = EXCLUDED.feed_address, aggregator_address = EXCLUDED.aggregator_address,
         discovery_source = EXCLUDED.discovery_source, verification_status = EXCLUDED.verification_status,
         last_checked_at = EXCLUDED.last_checked_at`,
      [feed.chainId, quoteAsset, feedAddress, feed.aggregatorAddress?.toLowerCase() ?? null, feed.discoverySource,
        feed.verificationStatus, feed.now],
    );
    const before = previous.rows[0];
    const mappingChanged = before === undefined || before.feed_address !== feedAddress || before.verification_status !== feed.verificationStatus;
    if (mappingChanged) {
      await invalidateForPriceChange(drizzle(client), {
        chainId: feed.chainId, quoteAssetAddress: quoteAsset, feedAddress, fromBlock: 0n, toBlock: MAX_BLOCK,
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
