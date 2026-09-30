import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { launches, trades, launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
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

  const realTrades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex }).from(trades).where(eq(trades.chainId, 4663));
  const stagingTrades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex }).from(tradesEnvioStaging);
  const tradeDiff = compareTradeCounts(realTrades, stagingTrades);
  console.log('Trades — matching:', tradeDiff.matching, 'only in real:', tradeDiff.onlyInReal.length, 'only in staging:', tradeDiff.onlyInStaging.length);
} finally {
  await pool.end();
}
