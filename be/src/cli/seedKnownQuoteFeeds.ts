import { createDatabase } from '../db/client.js';
import { upsertQuoteFeed } from '../market/quotePricing/feedRegistry.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(databaseUrl);
const now = new Date();

// The 4 quote-asset addresses previously hardcoded in usdPricing.ts's FEEDS map (two of them —
// native ETH's zero address and WETH — share the same ETH/USD feed). aggregatorAddress is left
// null: these rows exist to restore TVL/FDV pricing immediately, not to make these quote assets
// eligible for Task 6's round-backfill worker (which needs the real aggregator address, resolved
// separately via discoverAndVerifyFeed/enqueueFeedResolutionJob if historical pricing for these
// specific assets is needed sooner than the natural job queue gets to them).
const KNOWN: { quoteAssetAddress: `0x${string}`; feedAddress: `0x${string}` }[] = [
  { quoteAssetAddress: '0x0000000000000000000000000000000000000000', feedAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' },
  { quoteAssetAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', feedAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' },
  { quoteAssetAddress: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', feedAddress: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2' },
  { quoteAssetAddress: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', feedAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
];

async function main() {
  for (const feed of KNOWN) {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: feed.quoteAssetAddress, feedAddress: feed.feedAddress,
      aggregatorAddress: null, discoverySource: 'known-seed-2026-10-04', verificationStatus: 'verified', now });
  }
  await pool.end();
  console.log(`Seeded ${KNOWN.length} known quote feeds`);
}

main();
