import { createServer, type Server } from 'node:http';

// Next.js server-side `fetch` calls (used by fe/src/app/**/page.tsx) are never intercepted by
// Playwright's `page.route`, which only sees browser-initiated requests. Playwright's e2e specs
// therefore need a real local BE stand-in process: this file. Point BE_API_URL / NEXT_PUBLIC_BE_API_URL
// at it (see playwright.config.ts) instead of running the real indexer/Postgres/RPC stack.

export const TOKEN_ADDRESS = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29';
export const CHAIN_ID = 4663;

const launchSummary = {
  chainId: CHAIN_ID,
  tokenAddress: TOKEN_ADDRESS,
  name: 'E2E Launch',
  symbol: 'E2E',
  platform: 'pons',
  protocolVersion: 'v2',
  quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: 18 },
  lifecycleStatus: 'trading',
  officialVolume24h: null,
  // Intentionally not caught_up: the "coverage thiếu" (missing coverage) e2e scenario must see
  // an honest "still syncing" badge, never a silently-completed one.
  coverageStatus: 'backfilling',
  fdvUsd: null,
  marketCapUsd: null,
  tvlUsd: null,
  week52High: null,
  week52Low: null,
  logoUri: null,
  description: null,
  websiteUrl: null,
  twitterUrl: null,
  launchTimestamp: null,
  change1h: null,
  change1d: null,
  officialVolume24hUsd: null,
  officialVolume24hUsdApprox: false,
};

const launchDetail = {
  ...launchSummary,
  officialVenues: [
    { id: 'pons-v2-curve:0xtoken', kind: 'curve', ref: '0xcurve', effectiveFromBlock: '100', effectiveToBlock: null },
  ],
  priceQuote: '0.0001',
  priceStale: false,
};

const trades = {
  items: [
    {
      venueId: 'pons-v2-curve:0xtoken',
      blockNumber: '100',
      txHash: '0xtx1',
      logIndex: 0,
      timestamp: 1_700_000_000,
      side: 'buy',
      activityKind: 'user_trade',
      tokenAmount: '1000',
      quoteAmount: '0.1',
      priceQuote: '0.0001',
      traderAddress: '0xtrader',
      usdValue: null,
      usdValueApprox: false,
      usdValueStatus: 'unavailable',
    },
  ],
  nextCursor: null,
};

const candles = {
  // Newest-first, matching be/src/api/store.ts's listCandles (`candles.reverse()`), so the e2e
  // suite exercises the same ordering the real BE sends instead of the FE's own ascending fixtures.
  items: [
    { intervalSeconds: 60, bucketStart: 1_700_000_060, open: '0.00011', high: '0.00015', low: '0.0001', close: '0.00013', quoteVolume: '0.2' },
    { intervalSeconds: 60, bucketStart: 1_700_000_000, open: '0.0001', high: '0.00012', low: '0.00009', close: '0.00011', quoteVolume: '0.1' },
  ],
  complete: false,
};

export function startMockApi(port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Echo the request's own origin, like be/src/api/server.ts's @fastify/cors config does for
    // the configured FE_ORIGIN, instead of a permissive wildcard that would hide CORS bugs.
    const origin = req.headers.origin;
    if (origin) res.setHeader('access-control-allow-origin', origin);

    if (url.pathname === '/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      req.on('close', () => res.end());
      return;
    }

    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/launches') {
      const search = url.searchParams.get('search')?.toLowerCase();
      const status = url.searchParams.get('status');
      const matches =
        (!search || launchSummary.name.toLowerCase().includes(search) || launchSummary.symbol.toLowerCase().includes(search)) &&
        (!status || launchSummary.lifecycleStatus === status);
      res.end(JSON.stringify({ items: matches ? [launchSummary] : [], nextCursor: null }));
    } else if (url.pathname === '/v1/sources') {
      res.end(JSON.stringify({ items: [{ id: 'pons-v2', chainId: CHAIN_ID, platform: 'pons', protocolVersion: 'v2' }] }));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}`) {
      res.end(JSON.stringify(launchDetail));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}/trades`) {
      res.end(JSON.stringify(trades));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}/candles`) {
      res.end(JSON.stringify(candles));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  server.listen(port);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3101);
  startMockApi(port);
  console.log(`mock BE listening on :${port}`);
}
