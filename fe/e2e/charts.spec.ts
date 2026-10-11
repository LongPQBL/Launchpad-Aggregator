import { expect, test } from '@playwright/test';
import { CHAIN_ID, TOKEN_ADDRESS } from './mock-api';

const tokenUrl = `/launches/${CHAIN_ID}/${TOKEN_ADDRESS}`;

async function openMockPool(page: import('@playwright/test').Page) {
  await page.goto('/pools');
  await page.getByRole('link', { name: /View pool MOCK1/ }).first().click();
  await expect(page.getByRole('tab', { name: 'Price' })).toBeVisible();
}

test('the token page offers an All range and remembers the line / candle choice', async ({ page }) => {
  await page.goto(tokenUrl);
  const candles = page.getByRole('tab', { name: 'Candlestick chart' });
  await expect(candles).toHaveAttribute('aria-selected', 'true'); // candles are the default
  await page.getByRole('link', { name: 'All' }).first().click();
  await expect(page).toHaveURL(/range=all/);
  await page.getByRole('tab', { name: 'Line chart' }).click();
  await expect(page.getByRole('tab', { name: 'Line chart' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Line chart' })).toHaveAttribute('aria-selected', 'true');
});

test('Volume and TVL on the token page hide the line / candle switch and keep the range tabs', async ({ page }) => {
  await page.goto(tokenUrl);
  await page.getByRole('tab', { name: 'Volume' }).click();
  await expect(page.getByTestId('history-chart-container')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Line chart' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '1W' }).last()).toBeVisible();
  await page.getByRole('tab', { name: 'TVL' }).click();
  await expect(page.getByTestId('history-chart-container')).toBeVisible();
});

test('a V3/V4 pool page has Liquidity and Depth tabs that show neither range tabs nor the line / candle switch', async ({ page }) => {
  await openMockPool(page);
  await expect(page.getByRole('tab', { name: 'Liquidity' })).toBeVisible();
  await page.getByRole('tab', { name: 'Liquidity' }).click();
  await expect(page.getByRole('img', { name: /^Liquidity of/ })).toBeVisible();
  expect(await page.getByTestId('liquidity-bar').count()).toBeGreaterThan(5);
  await expect(page.getByRole('link', { name: '1W' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Line chart' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Depth' }).click();
  await expect(page.getByRole('img', { name: 'Depth chart' })).toBeVisible();
  await expect(page.getByTestId('depth-spread')).toContainText('Spread 0.1% (Fee tier 0.05%)');
  expect(await page.getByTestId('depth-ask-row').count()).toBeGreaterThan(0);
  expect(await page.getByTestId('depth-bid-row').count()).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: '1W' })).toHaveCount(0);
  // Back to Price: the range tabs and the style switch return.
  await page.getByRole('tab', { name: 'Price' }).click();
  await expect(page.getByRole('link', { name: '1W' }).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Line chart' })).toBeVisible();
});

test('the Depth chart zooms in and out', async ({ page }) => {
  await openMockPool(page);
  await page.getByRole('tab', { name: 'Depth' }).click();
  const asks = page.getByTestId('depth-asks');
  await expect(asks).toHaveAttribute('data-rows', '40');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(asks).toHaveAttribute('data-rows', '20');
  await page.getByRole('button', { name: 'Fit to chart' }).click();
  await expect(asks).toHaveAttribute('data-rows', '40');
});

test('the bonding-curve page has a Depth tab (no TVL or Liquidity) with its notes', async ({ page }) => {
  await page.goto(`${tokenUrl}/curve`);
  await expect(page.getByRole('tab', { name: 'Depth' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'TVL' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Liquidity' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Depth' }).click();
  await expect(page.getByTestId('depth-spread')).toContainText('Spread 2% (Fee 1%)');
  await expect(page.getByText('Amounts exclude the creator tax and snipe protection.')).toBeVisible();
  await expect(page.getByText('Buying beyond the last row graduates the curve.')).toBeVisible();
});

test('no chart tab leaves the page wider than the screen', async ({ page }) => {
  await openMockPool(page);
  for (const tab of ['Volume', 'Liquidity', 'Depth', 'Price']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${tab} tab overflows the page by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});
