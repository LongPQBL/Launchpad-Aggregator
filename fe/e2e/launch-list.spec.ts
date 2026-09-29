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

  // Scoped to <main> (AppShell's content landmark) so Next's own dev-mode toolbar button,
  // which lives outside it, is not mistaken for an in-app trading/wallet control.
  const appContent = page.getByRole('main');
  await expect(appContent.getByRole('button')).toHaveCount(0);
  await expect(appContent.getByText(/wallet|connect wallet|kết nối ví/i)).toHaveCount(0);
});

test('connects to the SSE realtime feed (proves the BE CORS response actually allows it)', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('status').filter({ hasText: /realtime/i })).toHaveText('Đang cập nhật realtime');
});
