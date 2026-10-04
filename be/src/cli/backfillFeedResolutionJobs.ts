import { createDatabase } from '../db/client.js';
import { enqueueFeedResolutionJob } from '../market/quotePricing/priceJobStore.js';

// runSync.ts/runSyncV2.ts only enqueue a feed_resolution job for a NEWLY inserted launch's quote
// asset — every launch that existed before Task 6 shipped never got one. One-off, idempotent
// (enqueueFeedResolutionJob dedupes): run once per environment to catch those up.
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const { pool } = createDatabase(databaseUrl);
  const result = await pool.query(
    `SELECT DISTINCT l.quote_asset_address FROM launches l WHERE l.chain_id = 4663
     AND NOT EXISTS (SELECT 1 FROM quote_usd_feeds f WHERE f.chain_id = 4663 AND f.quote_asset_address = l.quote_asset_address)`,
  );
  for (const row of result.rows as { quote_asset_address: string }[]) {
    await enqueueFeedResolutionJob(pool, 4663, row.quote_asset_address);
  }
  console.log(`Enqueued feed-resolution jobs for ${result.rows.length} distinct quote asset(s) with no existing quote_usd_feeds row`);
  await pool.end();
}

main();
