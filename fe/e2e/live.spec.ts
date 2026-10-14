import { expect, test } from './fixtures';
import { CHAIN_ID, LIVE_POOL_INDEX, LIVE_TOKEN_ADDRESS } from './mock-api';

const BE_URL = 'http://127.0.0.1:3101';
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
