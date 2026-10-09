import { expect, test } from './fixtures';
import { CHAIN_ID, SHORT_DESCRIPTION_TOKEN_ADDRESS, TOKEN_ADDRESS } from './mock-api';

test.beforeEach(async ({ page }) => {
  await page.goto(`/launches/${CHAIN_ID}/${TOKEN_ADDRESS}`);
});

test('shows launch identity, source, and official venues', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /E2E Launch/i })).toBeVisible();
  await expect(page.getByRole('link', { name: 'pons' })).toHaveAttribute('href', 'https://docs.ponsfamily.com/');
  const venueSection = page.getByRole('region', { name: /official trading venues/i });
  await expect(venueSection.getByText('Bonding curve')).toBeVisible();
});

// The UI deliberately shows no badge while a source is still backfilling (CoverageBadge renders nothing for
// it); what must never happen is a "Caught up" claim for a launch whose mock coverage is `backfilling`.
test('never claims the launch is fully caught up while its coverage is still backfilling', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /E2E Launch/i })).toBeVisible();
  await expect(page.getByText('Caught up')).toHaveCount(0);
});

test('shows the transactions table on the Transactions tab', async ({ page }) => {
  await expect(page.getByRole('tab', { name: 'Transactions' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('table', { name: 'Transactions' })).toBeVisible();
});

test('renders the official chart without crashing on the BE\'s real (newest-first) candle order', async ({ page }) => {
  const chartCanvas = page.locator('[data-testid="official-chart-container"] canvas').first();
  await expect(chartCanvas).toBeVisible();
});

test('the header offers wallet connection while the read-only detail content has no trade-execution controls', async ({ page }) => {
  // <header> is a direct child of the page's top-level wrapper (not nested in <main>), so it has
  // the implicit 'banner' landmark role — this is where AppShell renders WalletControl.
  await expect(page.getByRole('banner').getByRole('button', { name: /^connect( wallet)?$/i })).toBeVisible();

  // <main> is the read-only detail content. About's own copy-address/show-more/show-less buttons
  // are legitimate utility controls and must stay allowed, as does the swap panel's "Flip swap
  // direction" button and its disconnected "Connect" action; only buttons whose name starts with
  // the buy/sell/swap execution verbs are forbidden here — unlike a broader "trade" substring, which would wrongly flag a future
  // non-executing label like a "View trade" link in the trade-history table.
  const appContent = page.getByRole('main');
  await expect(appContent.getByRole('button', { name: /^(buy|sell|swap)\b/i })).toHaveCount(0);
});

test('the trade panel never offers Limit or Buy/Sell tabs', async ({ page }) => {
  await expect(page.getByRole('tab', { name: /^limit$/i })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^(buy|sell)$/i })).toHaveCount(0);
});

test('renders the unified swap panel with its venue badge and both amount inputs', async ({ page }) => {
  await expect(page.getByText('Bonding curve').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sell amount' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Buy amount' })).toBeVisible();
});

test('shows and expands Show more for a long description at both mobile and desktop widths', async ({ page }) => {
  for (const viewport of [{ width: 375, height: 800 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    const toggle = page.getByRole('button', { name: /show more/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('button', { name: /show less/i })).toBeVisible();
  }
});

test('shows no Show more for a short description that does not overflow, at both widths', async ({ page }) => {
  for (const viewport of [{ width: 375, height: 800 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/launches/${CHAIN_ID}/${SHORT_DESCRIPTION_TOKEN_ADDRESS}`);
    await expect(page.getByText('A short description that fits on one line and must not overflow three lines.')).toBeVisible();
    await expect(page.getByRole('button', { name: /show more/i })).not.toBeVisible();
  }
});

test('returns not-found for an invalid token route', async ({ page }) => {
  const response = await page.goto(`/launches/${CHAIN_ID}/not-an-address`);
  expect(response?.status()).toBe(404);
});
