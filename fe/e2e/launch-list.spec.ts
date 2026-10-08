import { expect, test } from './fixtures';
import { CHAIN_ID, TOKEN_ADDRESS } from './mock-api';

test('lists indexed launches and navigates from list to detail', async ({ page }) => {
  await page.goto('/');

  const launchLink = page.getByRole('link', { name: /E2E Launch/i });
  await expect(launchLink).toBeVisible();

  await launchLink.click();

  await expect(page).toHaveURL(new RegExp(`/launches/${CHAIN_ID}/${TOKEN_ADDRESS}$`));
  await expect(page.getByRole('heading', { name: /E2E Launch/i })).toBeVisible();
});

test('shows no wallet-connect or trade-execution controls on the list page', async ({ page }) => {
  await page.goto('/');

  // Scoped to <main> so Next's own dev-mode toolbar button is not mistaken for an in-app control.
  // The search form's "Search" submit button is expected and legitimate (not a trading/wallet control).
  const appContent = page.getByRole('main');
  await expect(appContent.getByRole('button', { name: /buy|sell|connect|wallet/i })).toHaveCount(0);
  await expect(appContent.getByText(/wallet|connect wallet/i)).toHaveCount(0);
});

test('switches tabs, searches, and filters lifecycle without reloading the page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.body.dataset.filterPageMarker = 'retained'; });
  await page.getByRole('link', { name: 'Recently launched' }).click();
  await expect(page).toHaveURL(/tab=recent/);

  const form = page.getByRole('search', { name: /search and filter launches/i });
  await form.getByRole('combobox', { name: /filter by lifecycle/i }).selectOption('trading');
  await form.getByRole('searchbox').fill('E2E');
  await form.getByRole('button', { name: /search/i }).click();

  await expect(page).toHaveURL(/search=E2E/);
  await expect(page).toHaveURL(/status=trading/);
  await expect(page).toHaveURL(/tab=recent/);
  await expect(page.getByRole('link', { name: /E2E Launch/i })).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.filterPageMarker)).toBe('retained');
});

test('keeps Pons launches when another launchpad and chain are selected', async ({ page }) => {
  await page.goto('/launches');
  const launchpadFilter = page.getByRole('navigation', { name: 'Filter by launchpad' });
  await launchpadFilter.locator('summary').click();
  await launchpadFilter.getByRole('button', { name: 'Pons', exact: true }).click();
  await launchpadFilter.getByRole('button', { name: 'NOXA', exact: true }).click();
  await expect(page.getByRole('link', { name: /E2E Launch/i })).toBeVisible();

  const chainFilter = page.getByRole('navigation', { name: 'Filter by chain' });
  await chainFilter.locator('summary').click();
  await chainFilter.getByRole('button', { name: 'Robinhood Chain', exact: true }).click();
  await chainFilter.getByRole('button', { name: 'Arc', exact: true }).click();
  await expect(page.getByRole('link', { name: /E2E Launch/i })).toBeVisible();
});

test('sorts numeric columns in both directions without reloading', async ({ page }) => {
  await page.goto('/launches');
  await page.evaluate(() => { document.body.dataset.sortPageMarker = 'retained'; });
  const table = page.getByRole('table', { name: 'Launch list' });
  const fdv = table.getByRole('columnheader', { name: /FDV/i });
  await fdv.getByRole('button', { name: /FDV/i }).click();
  await expect(fdv).toHaveAttribute('aria-sort', 'descending');
  await expect(table.getByRole('row').nth(1)).toContainText('E2E Launch');
  await fdv.getByRole('button', { name: /FDV/i }).click();
  await expect(fdv).toHaveAttribute('aria-sort', 'ascending');
  await expect(table.getByRole('row').nth(1)).toContainText('Mock Launch 60');
  expect(await page.evaluate(() => document.body.dataset.sortPageMarker)).toBe('retained');
});

test('connects to the SSE realtime feed (proves the BE CORS response actually allows it)', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('status').filter({ hasText: /realtime/i })).toHaveText('Live realtime updates');
});
