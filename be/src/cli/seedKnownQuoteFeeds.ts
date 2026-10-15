import { createDatabase } from '../db/client.js';
import { upsertQuoteFeed } from '../market/quotePricing/feedRegistry.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(databaseUrl);
const now = new Date();

// Native ETH and WETH share the ETH/USD proxy. Aggregator addresses were read from each
// proxy's aggregator() on Robinhood Chain (4663); refresh these values if a proxy rotates.
const KNOWN: { quoteAssetAddress: `0x${string}`; feedAddress: `0x${string}`; aggregatorAddress: `0x${string}` }[] = [
  { quoteAssetAddress: '0x0000000000000000000000000000000000000000', feedAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', aggregatorAddress: '0x6091E64eb7138EEF066a80FD3A0d7427B91f2721' },
  { quoteAssetAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', feedAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', aggregatorAddress: '0x6091E64eb7138EEF066a80FD3A0d7427B91f2721' },
  { quoteAssetAddress: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', feedAddress: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2', aggregatorAddress: '0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e' },
  { quoteAssetAddress: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', feedAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', aggregatorAddress: '0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2' },
];

async function main() {
  for (const feed of KNOWN) {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: feed.quoteAssetAddress, feedAddress: feed.feedAddress,
      aggregatorAddress: feed.aggregatorAddress, discoverySource: 'known-seed-2026-10-04', verificationStatus: 'verified', now });
  }
  await pool.end();
  console.log(`Seeded ${KNOWN.length} known quote feeds`);
}

main();
