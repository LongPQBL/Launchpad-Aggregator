import { eq, and } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { launches, trades, venues, launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { compareLaunchCounts, compareTradeCounts } from '../envioSync/compareStaging.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(databaseUrl);

try {
  const realLaunches = await db.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, 'pons-v1-legacy'));
  const stagingLaunches = await db.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging);
  const launchDiff = compareLaunchCounts(realLaunches, stagingLaunches);
  console.log('Launches — matching:', launchDiff.matching, 'only in real:', launchDiff.onlyInReal.length, 'only in staging:', launchDiff.onlyInStaging.length);
  if (launchDiff.onlyInReal.length) console.log('  only in real:', launchDiff.onlyInReal.slice(0, 20));
  if (launchDiff.onlyInStaging.length) console.log('  only in staging:', launchDiff.onlyInStaging.slice(0, 20));

  // Scope to pons-v1-legacy's own venues only — trades.chainId alone would also pull in
  // pons-v1-active/V2 curve/V4 trades, which this Phase 1 slice never syncs, making every one of
  // them show up as a spurious "only in real" mismatch.
  const realTrades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex })
    .from(trades)
    .innerJoin(venues, eq(trades.venueId, venues.id))
    .where(and(eq(trades.chainId, 4663), eq(venues.sourceId, 'pons-v1-legacy')));
  const stagingTrades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex }).from(tradesEnvioStaging);
  const tradeDiff = compareTradeCounts(realTrades, stagingTrades);
  console.log('Trades — matching:', tradeDiff.matching, 'only in real:', tradeDiff.onlyInReal.length, 'only in staging:', tradeDiff.onlyInStaging.length);
} finally {
  await pool.end();
}
