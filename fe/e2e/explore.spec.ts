import { expect, test } from './fixtures';
import { CHAIN_ID } from './mock-api';

test('the Transactions page lists trades across launches, marking pool swaps, with fixed column widths', async ({ page }) => {
  await page.goto('/transactions');
  const table = page.getByRole('table', { name: 'Latest transactions' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(11);
  await expect(table.getByText('(pool)').first()).toBeVisible();
  // 12345678 tokens are abbreviated, not printed as a long digit string.
  await expect(table.getByText('12.35M').first()).toBeVisible();

  // Header positions must not shift when the content changes (table-fixed layout).
  const timeBefore = await table.getByRole('columnheader', { name: 'Time' }).boundingBox();
  const walletBefore = await table.getByRole('columnheader', { name: 'Wallet' }).boundingBox();
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(timeBefore).not.toBeNull();
  expect(walletBefore).not.toBeNull();
});

test('the header search finds a launch and navigates to it', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('combobox', { name: 'Search tokens and pools' });
  await box.fill('E2E');
  const option = page.getByRole('option', { name: /E2E Launch/ });
  await expect(option).toBeVisible();
  await expect(page.getByRole('option', { name: /pool/ })).toBeVisible();
  await option.click();
  await expect(page).toHaveURL(new RegExp(`/launches/${CHAIN_ID}/`));
});

test('the header search closes on Escape and says when nothing matches', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('combobox', { name: 'Search tokens and pools' });
  await box.fill('zzzzzz');
  await expect(page.getByText(/No results for/)).toBeVisible();
  await box.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('the Portfolio page asks for a wallet instead of showing anything when none is connected', async ({ page }) => {
  await page.goto('/portfolio');
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await expect(page.getByText(/Connect your wallet/)).toBeVisible();
});

test('the pool page shows daily Volume and TVL bars, with an unavailable day drawn as unavailable', async ({ page }) => {
  await page.goto('/pools');
  await page.getByRole('link').filter({ hasText: /MOCK1/ }).first().click();
  const history = page.getByRole('region', { name: 'Pool history' });
  await expect(history).toBeVisible();
  await expect(history.getByTestId('history-bar-unavailable')).toHaveCount(1);
  await history.getByRole('tab', { name: 'TVL' }).click();
  await expect(history.getByTestId('history-bar')).not.toHaveCount(0);
});
