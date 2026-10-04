import { expect, test } from './fixtures';
import { CHAIN_ID, TOKEN_ADDRESS } from './mock-api';

test.beforeEach(async ({ page }) => {
  await page.goto(`/launches/${CHAIN_ID}/${TOKEN_ADDRESS}`);
});

test('shows launch identity, source, and official venues', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /E2E Launch/i })).toBeVisible();
  await expect(page.getByRole('link', { name: 'pons' })).toHaveAttribute('href', 'https://docs.ponsfamily.com/');
  const venueSection = page.getByRole('region', { name: /official trading venues/i });
  await expect(venueSection.getByText('Bonding curve')).toBeVisible();
});

test('shows the syncing coverage state honestly instead of hiding it', async ({ page }) => {
  const badges = page.getByTestId('coverage-badge');
  await expect(badges.first()).toBeVisible();
  await expect(badges.first()).toHaveText('Backfilling');
});

test('shows the official trade history table', async ({ page }) => {
  await expect(page.getByRole('table', { name: /official trades/i })).toBeVisible();
});

test('renders the official chart without crashing on the BE\'s real (newest-first) candle order', async ({ page }) => {
  const chartCanvas = page.locator('[data-testid="official-chart-container"] canvas').first();
  await expect(chartCanvas).toBeVisible();
});

test('shows no wallet-connect or trade-execution controls on the detail page', async ({ page }) => {
  // Scoped to <main> (AppShell's content landmark) so Next's own dev-mode toolbar button,
  // which lives outside it, is not mistaken for an in-app trading/wallet control. The About
  // section's own "copy address"/"show more" buttons are legitimate non-wallet controls (added
  // this session) — matched by name instead of asserting zero buttons on the page.
  const appContent = page.getByRole('main');
  await expect(appContent.getByRole('button', { name: /wallet|connect|buy|sell|trade|swap/i })).toHaveCount(0);
  await expect(appContent.getByText(/wallet|connect wallet|kết nối ví/i)).toHaveCount(0);
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

test('returns not-found for an invalid token route', async ({ page }) => {
  const response = await page.goto(`/launches/${CHAIN_ID}/not-an-address`);
  expect(response?.status()).toBe(404);
});
