import { createServer, type Server } from 'node:http';

// Next.js server-side `fetch` calls (used by fe/src/app/**/page.tsx) are never intercepted by
// Playwright's `page.route`, which only sees browser-initiated requests. Playwright's e2e specs
// therefore need a real local BE stand-in process: this file. Point BE_API_URL / NEXT_PUBLIC_BE_API_URL
// at it (see playwright.config.ts) instead of running the real indexer/Postgres/RPC stack.

export const TOKEN_ADDRESS = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29';
export const CHAIN_ID = 4663;
// A second, short-description launch — a real-browser negative case for the About section's
// overflow-gated Show more control, alongside the long-description positive case above. A separate
// token/route is required (not a query param or page.route override) because this page's initial
// data load happens via a Next.js server-side fetch, which Playwright's page.route never sees.
export const SHORT_DESCRIPTION_TOKEN_ADDRESS = '0xd9e9ab90654f82893d7fd18b62f694992e8cef29';

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
  priceUsd: null,
  week52High: null,
  week52Low: null,
  logoUri: null,
  websiteUrl: null,
  twitterUrl: null,
  launchTimestamp: null,
  change1h: null,
  change1d: null,
  officialVolume24hUsd: null,
  officialVolume24hUsdApprox: false,
};

const mockLaunches = Array.from({ length: 60 }, (_, index) => ({
  ...launchSummary,
  tokenAddress: index === 0 ? TOKEN_ADDRESS : `0x${(index + 500).toString(16).padStart(40, '0')}`,
  name: index === 0 ? 'E2E Launch' : `Mock Launch ${index + 1}`,
  symbol: index === 0 ? 'E2E' : `MOCK${index + 1}`,
  fdvUsd: String(60 - index),
  tvlUsd: String(index + 1),
  change1h: String(index - 30),
  change1d: String(30 - index),
  launchTimestamp: String(1_780_000_000 - index * 60),
}));

const launchDetail = {
  ...launchSummary,
  websiteUrl: 'https://example.com/mock-launch',
  twitterUrl: 'https://x.com/mock_launch',
  // description is only a part of the detail response (fe/src/api/server.ts's LaunchSummary/
  // LaunchDetail split, Task 5) — kept off launchSummary so the mocked /v1/launches list response
  // matches the real API's shape, not just the FE's observed behavior of ignoring the field.
  description: Array.from({ length: 8 },
    () => 'E2E Launch is a long-form test description written specifically to exceed three lines of wrapped ' +
      'text at both narrow mobile viewports and wide desktop viewports, so the Playwright suite can verify ' +
      'the real browser line-clamp overflow detection end to end, independent of the jsdom unit tests that ' +
      'mock scrollHeight and clientHeight instead of performing real layout.').join(' '),
  officialVenues: [
    { id: 'pons-v2-curve:0xtoken', kind: 'curve', ref: '0xcurve', effectiveFromBlock: '100', effectiveToBlock: null },
  ],
  priceUsd: '0.00012',
  priceQuote: '0.0001',
  priceStale: false,
  quotePriceUsd: '3000',
};

const shortDescriptionDetail = {
  ...launchDetail,
  tokenAddress: SHORT_DESCRIPTION_TOKEN_ADDRESS,
  name: 'E2E Short Description Launch',
  description: 'A short description that fits on one line and must not overflow three lines.',
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

const transactions = {
  items: Array.from({ length: 12 }, (_, index) => ({
    source: index % 3 === 0 ? 'pool' : 'official',
    venueId: index % 3 === 0 ? null : 'pons-v2-curve:0xtoken',
    pool: index % 3 === 0 ? { protocol: 'uniswap_v4', poolId: `0x${'1'.padStart(64, '0')}` } : null,
    blockNumber: String(200 + index),
    txHash: `0x${(index + 100).toString(16).padStart(64, '0')}`,
    logIndex: index,
    timestamp: 1_780_000_000 - index * 900,
    side: index % 2 === 0 ? 'buy' : 'sell',
    activityKind: 'user_trade',
    tokenAmount: String(1250 + index * 375),
    quoteAmount: (0.15 + index * 0.025).toFixed(4),
    quoteAssetAddress: '0xquote',
    traderAddress: `0x${(index + 300).toString(16).padStart(40, '0')}`,
    usdValue: (18 + index * 3.25).toFixed(2),
    usdValueApprox: false,
    usdValueStatus: 'priced',
  })),
  nextCursor: null,
};

function mockCandles(intervalSeconds: number, currency: 'quote' | 'usd') {
  const base = currency === 'usd' ? 0.00012 : 0.0001;
  const items = Array.from({ length: 60 }, (_, index) => {
    const close = base * (1 + index * 0.002);
    return {
      intervalSeconds,
      bucketStart: 1_700_000_000 + index * intervalSeconds,
      open: (close * 0.997).toFixed(12),
      high: (close * 1.015).toFixed(12),
      low: (close * 0.985).toFixed(12),
      close: close.toFixed(12),
      quoteVolume: (0.1 + index * 0.002).toFixed(4),
    };
  });
  // Match the API's newest-first candle order; the chart sorts ascending before plotting.
  return { items: items.reverse(), complete: false };
}

const mockPools = Array.from({ length: 60 }, (_, index) => ({
  chainId: CHAIN_ID,
  protocol: 'uniswap_v4',
  poolId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  currency0: `0x${(index + 101).toString(16).padStart(40, '0')}`,
  currency1: '0x0000000000000000000000000000000000000000',
  displayedToken: `0x${(index + 101).toString(16).padStart(40, '0')}`,
  currency0Symbol: `MOCK${index + 1}`,
  currency0Name: `Mock Token ${index + 1}`,
  currency0LogoUri: null,
  currency0Decimals: 18,
  currency1Symbol: 'ETH',
  currency1Name: 'Ethereum',
  currency1LogoUri: null,
  currency1Decimals: 18,
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
  createdBlock: String(1000 + index),
  // Pool #2 is under 24h old (volume shows "New"); others keep a fixed older timestamp.
  createdTimestamp: index === 1 ? Math.floor(Date.now() / 1000) - 7_200 : 1_780_000_000 - (index + 1) * 43_200,
  ponsDesignated: index === 0,
  launchTokenAddress: null,
  volume24hUsd: (52_000 - index * 640).toFixed(2),
  volume30dUsd: index === 4 ? null : ((52_000 - index * 640) * 21).toFixed(2),
  // null => hidden in the UI (pool #3 has no volume change at all; #2 is new).
  volume24hChange: index === 1 || index === 2 ? null : (-62.38 + index * 9).toFixed(2),
  tvlChange: index === 2 || index % 4 === 3 ? null : (-13.38 + index * 6).toFixed(2),
  priceInQuote: (0.000112 + index * 0.0000015).toFixed(8),
  poolBalances: {
    displayedAmountRaw: String(BigInt(300_000 + index * 5_000) * 10n ** 18n),
    otherAmountRaw: String(BigInt(40 + index) * 10n ** 18n),
    priceInQuote: (0.000112 + index * 0.0000015).toFixed(8),
  },
  priceUsd: (0.28 + index * 0.004).toFixed(6),
  fdvUsd: (980_000 - index * 8_200).toFixed(2),
  tvlUsd: (184_500 - index * 2_100).toFixed(2),
  change1h: (1.8 - (index % 7) * 0.6).toFixed(2),
  change1d: (14.2 - (index % 11) * 2.3).toFixed(2),
  coverageStatus: 'caught_up',
  lastTradeTimestamp: 1_780_000_000 - (index + 1) * 180,
}));

const launchPools = Array.from({ length: 4 }, (_, index) => ({
  ...mockPools[index],
  poolId: `0x${(index + 701).toString(16).padStart(64, '0')}`,
  currency0: TOKEN_ADDRESS,
  currency1: index % 2 === 0 ? '0x0000000000000000000000000000000000000000' : '0xquote',
  displayedToken: TOKEN_ADDRESS,
  currency0Symbol: 'E2E',
  currency0Name: 'E2E Launch',
  currency1Symbol: index % 2 === 0 ? 'ETH' : 'ROBIN',
  currency1Name: index % 2 === 0 ? 'Ethereum' : 'Robin',
  ponsDesignated: false,
  launchTokenAddress: TOKEN_ADDRESS,
  volume24hUsd: (2450 - index * 375).toFixed(2),
  volume30dUsd: ((2450 - index * 375) * 18).toFixed(2),
  volume24hChange: (index * 5 - 10).toFixed(2),
  tvlChange: (index * 4 - 8).toFixed(2),
  priceInQuote: (0.0001 + index * 0.00001).toFixed(8),
  poolBalances: {
    ...mockPools[index].poolBalances,
    priceInQuote: (0.0001 + index * 0.00001).toFixed(8),
  },
  priceUsd: (0.00012 + index * 0.00001).toFixed(8),
  fdvUsd: (120000 + index * 15000).toFixed(2),
  tvlUsd: (18600 - index * 2300).toFixed(2),
  change1h: (2.4 - index * 1.1).toFixed(2),
  change1d: (13.8 - index * 5.2).toFixed(2),
  coverageStatus: 'caught_up',
  createdTimestamp: 1_780_000_000 - (index + 1) * 86_400,
  lastTradeTimestamp: 1_780_000_000 - (index + 1) * 300,
}));

const globalTransactions = {
  items: Array.from({ length: 10 }, (_, index) => ({
    source: index % 4 === 0 ? 'pool' : 'official',
    venueId: index % 4 === 0 ? null : 'pons-v2-curve:0xtoken',
    pool: index % 4 === 0 ? { protocol: 'uniswap_v4', poolId: `0x${'1'.padStart(64, '0')}` } : null,
    token: { chainId: CHAIN_ID, tokenAddress: TOKEN_ADDRESS, name: 'E2E Launch', symbol: 'E2E', logoUri: null },
    blockNumber: String(900 - index), txHash: `0x${(index + 500).toString(16).padStart(64, '0')}`, logIndex: index,
    timestamp: 1_780_000_000 - index * 120, side: index % 2 === 0 ? 'buy' : 'sell', activityKind: index % 4 === 0 ? null : 'user_trade',
    tokenAmount: String(12_345_678 + index), quoteAmount: (0.5 + index * 0.1).toFixed(4),
    quoteAsset: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', logoUri: null },
    traderAddress: `0x${(index + 700).toString(16).padStart(40, '0')}`,
    usdValue: (1500 + index * 10).toFixed(2), usdValueApprox: true, usdValueStatus: 'priced',
  })),
  nextCursor: null,
};

const DAY_SECONDS = 86_400;
const poolHistory = {
  items: Array.from({ length: 30 }, (_, index) => ({
    day: Math.floor(1_780_000_000 / DAY_SECONDS) * DAY_SECONDS - (29 - index) * DAY_SECONDS,
    tradeCount: index % 5 === 0 ? 0 : 3 + index,
    // Day 7 is deliberately unavailable (an unpriced swap) and every fifth day is a real zero.
    volumeUsd: index === 7 ? null : index % 5 === 0 ? '0' : String(1000 + index * 350),
    tvlUsd: index >= 22 ? String(40_000 + index * 100) : null,
  })),
  complete: true,
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
      const platforms = url.searchParams.get('platform')?.split(',').map((value) => value.trim()).filter(Boolean);
      const chainIds = url.searchParams.get('chainId')?.split(',').map((value) => value.trim()).filter(Boolean);
      const matches = mockLaunches.filter((launch) =>
        (!search || launch.name.toLowerCase().includes(search) || launch.symbol.toLowerCase().includes(search)) &&
        (!status || launch.lifecycleStatus === status) &&
        (!platforms || platforms.includes(launch.platform)) &&
        (!chainIds || chainIds.includes(String(launch.chainId))));
      const sort = url.searchParams.get('sort') ?? 'recent';
      const direction = url.searchParams.get('direction') ?? (sort === 'recent' ? 'asc' : 'desc');
      const field = ({ fdvUsd: 'fdvUsd', tvlUsd: 'tvlUsd', change1h: 'change1h', change1d: 'change1d',
        volume24hUsd: 'officialVolume24hUsd', recent: 'launchTimestamp' } as const)[sort as 'fdvUsd'];
      if (field) matches.sort((a, b) => {
        const left = a[field] === null ? null : Number(a[field]);
        const right = b[field] === null ? null : Number(b[field]);
        if (left === null) return right === null ? 0 : 1;
        if (right === null) return -1;
        const ageSign = sort === 'recent' ? -1 : 1;
        return (left - right) * ageSign * (direction === 'asc' ? 1 : -1);
      });
      const secondPage = url.searchParams.get('cursor') === 'mock-launches-page-2';
      res.end(JSON.stringify({
        items: secondPage ? matches.slice(50) : matches.slice(0, 50),
        nextCursor: !secondPage && matches.length > 50 ? 'mock-launches-page-2' : null,
      }));
    } else if (url.pathname === '/v1/pools') {
      const secondPage = url.searchParams.get('cursor') === 'mock-pools-page-2';
      res.end(JSON.stringify({
        items: secondPage ? mockPools.slice(50) : mockPools.slice(0, 50),
        nextCursor: secondPage ? null : 'mock-pools-page-2',
        supportedProtocols: ['uniswap_v4'],
      }));
    } else if (url.pathname === '/v1/transactions') {
      // Like the real API: chainId is one id or a comma-separated list; no chainId means every chain.
      const chainIds = url.searchParams.get('chainId')?.split(',').map((value) => Number(value.trim()));
      res.end(JSON.stringify({
        ...globalTransactions,
        items: chainIds ? globalTransactions.items.filter((item) => chainIds.includes(item.token.chainId)) : globalTransactions.items,
      }));
    } else if (url.pathname === '/v1/search') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const tokens = mockLaunches.filter((launch) => launch.name.toLowerCase().includes(query) || launch.symbol.toLowerCase().includes(query))
        .slice(0, 5).map((launch) => ({ chainId: launch.chainId, tokenAddress: launch.tokenAddress, name: launch.name,
          symbol: launch.symbol, logoUri: null, platform: launch.platform }));
      const pools = tokens.length === 0 ? [] : [{ chainId: CHAIN_ID, protocol: 'uniswap_v4', poolId: mockPools[0].poolId, fee: 3000,
        currency0: mockPools[0].currency0, currency1: mockPools[0].currency1,
        launchToken: { address: tokens[0].tokenAddress, name: tokens[0].name, symbol: tokens[0].symbol, logoUri: null } }];
      res.end(JSON.stringify({ tokens, pools }));
    } else if (/^\/v1\/wallets\/0x[0-9a-fA-F]{40}\/positions$/.test(url.pathname)) {
      res.end(JSON.stringify({ items: [] }));
    } else if (url.pathname === '/v1/sources') {
      res.end(JSON.stringify({ items: [{ id: 'pons-v2', chainId: CHAIN_ID, platform: 'pons', protocolVersion: 'v2' }] }));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}`) {
      res.end(JSON.stringify(launchDetail));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}/trades`) {
      res.end(JSON.stringify(trades));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}/transactions`) {
      res.end(JSON.stringify(transactions));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}/pools`) {
      res.end(JSON.stringify({ items: launchPools, nextCursor: null, supportedProtocols: ['uniswap_v4'] }));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${TOKEN_ADDRESS}/candles`) {
      const intervalSeconds = Number(url.searchParams.get('intervalSeconds') ?? 3600);
      const currency = url.searchParams.get('currency') === 'usd' ? 'usd' : 'quote';
      res.end(JSON.stringify(mockCandles(intervalSeconds, currency)));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${SHORT_DESCRIPTION_TOKEN_ADDRESS}`) {
      res.end(JSON.stringify(shortDescriptionDetail));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${SHORT_DESCRIPTION_TOKEN_ADDRESS}/trades`) {
      res.end(JSON.stringify(trades));
    } else if (url.pathname === `/v1/launches/${CHAIN_ID}/${SHORT_DESCRIPTION_TOKEN_ADDRESS}/candles`) {
      const intervalSeconds = Number(url.searchParams.get('intervalSeconds') ?? 3600);
      const currency = url.searchParams.get('currency') === 'usd' ? 'usd' : 'quote';
      res.end(JSON.stringify(mockCandles(intervalSeconds, currency)));
    } else if (/^\/v1\/pools\/\d+\/[^/]+\/[^/]+\/candles$/.test(url.pathname)) {
      const intervalSeconds = Number(url.searchParams.get('intervalSeconds') ?? 3600);
      res.end(JSON.stringify(mockCandles(intervalSeconds, 'quote')));
    } else if (/^\/v1\/pools\/\d+\/[^/]+\/[^/]+\/history$/.test(url.pathname)) {
      res.end(JSON.stringify(poolHistory));
    } else if (/^\/v1\/pools\/\d+\/[^/]+\/[^/]+\/trades$/.test(url.pathname)) {
      const items = Array.from({ length: 8 }, (_, index) => ({
        txHash: `0x${(index + 900).toString(16).padStart(64, '0')}`,
        logIndex: index, blockNumber: String(300 + index), timestamp: 1_780_000_000 - index * 600,
        traderAddress: `0x${(index + 200).toString(16).padStart(40, '0')}`,
        side: index % 2 === 0 ? 'buy' : 'sell',
        // Large values make it easy to review transaction column widths in the mock detail page.
        amount0Raw: String(BigInt(1_234_567 + index * 234_567) * 10n ** 18n),
        amount1Raw: String(BigInt(98_765 + index * 12_345) * 10n ** 18n),
        priceInQuote: '0.0001', usdValue: (1_234_567 + index * 123_456).toFixed(2), usdValueStatus: 'priced',
      }));
      res.end(JSON.stringify({ items, nextCursor: null }));
    } else if (/^\/v1\/pools\/\d+\/[^/]+\/[^/]+$/.test(url.pathname)) {
      const [, , , , protocol, poolIdRaw] = url.pathname.split('/');
      const poolId = decodeURIComponent(poolIdRaw).toLowerCase();
      const pool = mockPools.find((p) => p.protocol === protocol && p.poolId.toLowerCase() === poolId);
      const displayedToken = url.searchParams.get('displayedToken');
      if (pool) {
        const reversed = displayedToken?.toLowerCase() === pool.currency1.toLowerCase();
        const reversedPrice = String(1 / Number(pool.priceInQuote));
        res.end(JSON.stringify(reversed ? {
          ...pool,
          displayedToken: pool.currency1,
          priceInQuote: reversedPrice,
          poolBalances: {
            displayedAmountRaw: pool.poolBalances.otherAmountRaw,
            otherAmountRaw: pool.poolBalances.displayedAmountRaw,
            priceInQuote: reversedPrice,
          },
        } : pool));
      }
      else { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); }
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
