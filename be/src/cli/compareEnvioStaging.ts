import { eq, and } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { launches, trades, venues, launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitions, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { compareLaunchCounts, compareTradeCounts } from '../envioSync/compareStaging.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(databaseUrl);

try {
  const realLaunches = await db.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, 'pons-v1-legacy'));
  // Scope to protocolVersion 'v1' — launches_envio_staging is shared with V2 (Phase 2), so an
  // unfiltered select here would count V2 rows as spurious "only in staging" for this comparison.
  const stagingLaunches = await db.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging).where(eq(launchesEnvioStaging.protocolVersion, 'v1'));
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
  // trades_envio_staging is shared with V2 curve trades (Phase 2) — scope to v3_pool venues only.
  const stagingTrades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex })
    .from(tradesEnvioStaging)
    .innerJoin(venuesEnvioStaging, eq(tradesEnvioStaging.venueId, venuesEnvioStaging.id))
    .where(eq(venuesEnvioStaging.kind, 'v3_pool'));
  const tradeDiff = compareTradeCounts(realTrades, stagingTrades);
  console.log('Trades — matching:', tradeDiff.matching, 'only in real:', tradeDiff.onlyInReal.length, 'only in staging:', tradeDiff.onlyInStaging.length);

  const realV2Launches = await db.select({ tokenAddress: launches.tokenAddress }).from(launches).where(eq(launches.sourceId, 'pons-v2'));
  const stagingV2Launches = await db.select({ tokenAddress: launchesEnvioStaging.tokenAddress }).from(launchesEnvioStaging).where(eq(launchesEnvioStaging.protocolVersion, 'v2'));
  const v2LaunchDiff = compareLaunchCounts(realV2Launches, stagingV2Launches);
  console.log('V2 launches — matching:', v2LaunchDiff.matching, 'only in real:', v2LaunchDiff.onlyInReal.length, 'only in staging:', v2LaunchDiff.onlyInStaging.length);

  const realV2Trades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex })
    .from(trades).innerJoin(venues, eq(trades.venueId, venues.id))
    .where(and(eq(trades.chainId, 4663), eq(venues.sourceId, 'pons-v2')));
  const stagingV2Trades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex })
    .from(tradesEnvioStaging).innerJoin(venuesEnvioStaging, eq(tradesEnvioStaging.venueId, venuesEnvioStaging.id))
    .where(eq(venuesEnvioStaging.kind, 'curve'));
  const v2TradeDiff = compareTradeCounts(realV2Trades, stagingV2Trades);
  console.log('V2 curve trades — matching:', v2TradeDiff.matching, 'only in real:', v2TradeDiff.onlyInReal.length, 'only in staging:', v2TradeDiff.onlyInStaging.length);

  const realTransitions = await db.select({ txHash: lifecycleTransitions.txHash, logIndex: lifecycleTransitions.logIndex }).from(lifecycleTransitions).where(eq(lifecycleTransitions.sourceId, 'pons-v2-lifecycle'));
  const stagingTransitions = await db.select({ txHash: lifecycleTransitionsEnvioStaging.txHash, logIndex: lifecycleTransitionsEnvioStaging.logIndex }).from(lifecycleTransitionsEnvioStaging);
  const transitionDiff = compareTradeCounts(realTransitions, stagingTransitions);
  console.log('Lifecycle transitions — matching:', transitionDiff.matching, 'only in real:', transitionDiff.onlyInReal.length, 'only in staging:', transitionDiff.onlyInStaging.length);

  const realV4Trades = await db.select({ txHash: trades.txHash, logIndex: trades.logIndex })
    .from(trades).innerJoin(venues, eq(trades.venueId, venues.id))
    .where(and(eq(trades.chainId, 4663), eq(venues.kind, 'v4_pool')));
  const stagingV4Trades = await db.select({ txHash: tradesEnvioStaging.txHash, logIndex: tradesEnvioStaging.logIndex })
    .from(tradesEnvioStaging).innerJoin(venuesEnvioStaging, eq(tradesEnvioStaging.venueId, venuesEnvioStaging.id))
    .where(eq(venuesEnvioStaging.kind, 'v4_pool'));
  const v4TradeDiff = compareTradeCounts(realV4Trades, stagingV4Trades);
  console.log('V4 swaps — matching:', v4TradeDiff.matching, 'only in real:', v4TradeDiff.onlyInReal.length, 'only in staging:', v4TradeDiff.onlyInStaging.length);
} finally {
  await pool.end();
}
