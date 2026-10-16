import { expect, test } from './fixtures';
import { CHAIN_ID, LIVE_POOL_INDEX, LIVE_TOKEN_ADDRESS } from './mock-api';

const BE_URL = process.env.E2E_MOCK_API_URL ?? 'http://127.0.0.1:3101';
// The mock announces a swap like the real API (SSE trade.created / pool.changed) the moment it is posted. The page's own
// fast path must show it well inside the page-wide refresh's 3 s throttle.
const SHOWS_WITHIN_MS = 1_500;

async function postSwap(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const response = await request.post(`${BE_URL}/__live/swap`);
  return (await response.json()).txHash as string;
}

test('a new swap appears on the token page transactions as soon as it is announced', async ({ page, request }) => {
  await page.goto(`/launches/${CHAIN_ID}/${LIVE_TOKEN_ADDRESS}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('table', { name: 'Transactions' })).toBeVisible();
  const txHash = await postSwap(request);
  await expect(page.locator(`a[href$="${txHash}"]`).first()).toBeVisible({ timeout: SHOWS_WITHIN_MS });
});

test('a new swap appears on the pool page transactions as soon as it is announced', async ({ page, request }) => {
  // Same ids the mock derives for mockPools[LIVE_POOL_INDEX].
  const poolId = `0x${(LIVE_POOL_INDEX + 1).toString(16).padStart(64, '0')}`;
  const currency0 = `0x${(LIVE_POOL_INDEX + 101).toString(16).padStart(40, '0')}`;
  await page.goto(`/pools/${CHAIN_ID}/uniswap_v4/${poolId}?displayedToken=${currency0}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('table', { name: 'Transactions' })).toBeVisible();
  const txHash = await postSwap(request);
  await expect(page.locator(`a[href$="${txHash}"]`).first()).toBeVisible({ timeout: SHOWS_WITHIN_MS });
});

// Read the latest candle that the chart component has handed to Lightweight Charts. Tooltip hover
// isn't reliable in touch emulation, and a fixed coordinate can land on an older candle on mobile.
async function newestCandleClose(page: import('@playwright/test').Page): Promise<string> {
  return (await page.getByTestId('official-chart-container').first().getAttribute('data-latest-candle-close')) ?? '';
}

test('the token price chart moves its newest candle when a swap is announced', async ({ page, request }) => {
  await page.goto(`/launches/${CHAIN_ID}/${LIVE_TOKEN_ADDRESS}`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-testid="official-chart-container"] canvas').first()).toBeVisible();
  await expect.poll(() => newestCandleClose(page)).not.toBe('');
  const before = await newestCandleClose(page);
  // The browser itself refetches the candles (the page-wide refresh would fetch them on the server), and the newest candle moves.
  const candleRequest = page.waitForRequest((r) => r.url().includes('/candles'), { timeout: 1_500 });
  await postSwap(request);
  await candleRequest;
  await expect.poll(() => newestCandleClose(page), { timeout: 10_000 }).not.toBe(before);
});

test('the pool price chart moves its newest candle when a swap lands in that pool', async ({ page, request }) => {
  const poolId = `0x${(LIVE_POOL_INDEX + 1).toString(16).padStart(64, '0')}`;
  const currency0 = `0x${(LIVE_POOL_INDEX + 101).toString(16).padStart(40, '0')}`;
  await page.goto(`/pools/${CHAIN_ID}/uniswap_v4/${poolId}?displayedToken=${currency0}`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-testid="official-chart-container"] canvas').first()).toBeVisible();
  await expect.poll(() => newestCandleClose(page)).not.toBe('');
  const before = await newestCandleClose(page);
  // The browser itself refetches the candles (the page-wide refresh would fetch them on the server), and the newest candle moves.
  const candleRequest = page.waitForRequest((r) => r.url().includes('/candles'), { timeout: 1_500 });
  await postSwap(request);
  await candleRequest;
  await expect.poll(() => newestCandleClose(page), { timeout: 10_000 }).not.toBe(before);
});

// The Volume bars are a canvas too; the headline total above them is the readable part.
async function volumeTotal(page: import('@playwright/test').Page): Promise<string> {
  return (await page.getByTestId('pool-history-readout').locator('[aria-label]').first().getAttribute('aria-label', { timeout: 1_000 }).catch(() => '')) ?? '';
}

test('the Volume total on the token page grows when a swap is announced', async ({ page, request }) => {
  await page.goto(`/launches/${CHAIN_ID}/${LIVE_TOKEN_ADDRESS}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Volume' }).click();
  await expect.poll(() => volumeTotal(page)).not.toBe('');
  const before = await volumeTotal(page);
  const historyRequest = page.waitForRequest((r) => r.url().includes('/history'), { timeout: 1_500 });
  await postSwap(request);
  await historyRequest;
  await expect.poll(() => volumeTotal(page), { timeout: 3_000 }).not.toBe(before);
});

test('the Volume total on the pool page grows when a swap lands in that pool', async ({ page, request }) => {
  const poolId = `0x${(LIVE_POOL_INDEX + 1).toString(16).padStart(64, '0')}`;
  const currency0 = `0x${(LIVE_POOL_INDEX + 101).toString(16).padStart(40, '0')}`;
  await page.goto(`/pools/${CHAIN_ID}/uniswap_v4/${poolId}?displayedToken=${currency0}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Volume' }).click();
  await expect.poll(() => volumeTotal(page)).not.toBe('');
  const before = await volumeTotal(page);
  const historyRequest = page.waitForRequest((r) => r.url().includes('/history'), { timeout: 1_500 });
  await postSwap(request);
  await historyRequest;
  await expect.poll(() => volumeTotal(page), { timeout: 3_000 }).not.toBe(before);
});

test('the Depth price on the pool page follows a swap in that pool', async ({ page, request }) => {
  const poolId = `0x${(LIVE_POOL_INDEX + 1).toString(16).padStart(64, '0')}`;
  const currency0 = `0x${(LIVE_POOL_INDEX + 101).toString(16).padStart(40, '0')}`;
  await page.goto(`/pools/${CHAIN_ID}/uniswap_v4/${poolId}?displayedToken=${currency0}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Depth' }).click();
  const headline = page.locator('p.text-2xl', { hasText: /^1 .* = / }).first();
  await expect(headline).toBeVisible();
  const before = await headline.textContent();
  // The chain-read refetch is throttled to one per 4 s (RPC_BACKED_MIN_INTERVAL_MS) counted from the fetch the tab click started, so under load the
  // announced swap can wait for that window before it triggers the request.
  const liquidityRequest = page.waitForRequest((r) => r.url().includes('/liquidity'), { timeout: 6_000 });
  await postSwap(request);
  await liquidityRequest;
  await expect.poll(async () => headline.textContent(), { timeout: 5_000 }).not.toBe(before);
});
