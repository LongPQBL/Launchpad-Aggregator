import { expect, test } from './fixtures';
import { CHAIN_ID } from './mock-api';

test('the Transactions page reads each trade as "Swap A for B" and has chain and type filters', async ({ page }) => {
  await page.goto('/transactions');
  const table = page.getByRole('table', { name: 'Latest transactions' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(11);
  await expect(table.getByText('(pool)')).toHaveCount(0);
  // A buy pays ETH for the launch token; a sell is the reverse.
  await expect(table.getByText(/^Swap$/).first()).toBeVisible();
  await expect(table.getByRole('row').nth(1)).toContainText('ETH');
  await expect(table.getByRole('row').nth(1)).toContainText('E2E');
  // Token amounts are abbreviated, and wallets use the checksum form with three dots.
  await expect(table.getByText('12.35M').first()).toBeVisible();
  await expect(table.getByText(/^0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}$/).first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Filter by chain' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Filter by type' })).toBeVisible();
});

test('choosing a chain filters the transactions to that chain and is kept in the URL', async ({ page }) => {
  await page.goto('/transactions');
  const table = page.getByRole('table', { name: 'Latest transactions' });
  await expect(table.getByRole('row')).toHaveCount(11);

  // Another chain has no trades: the Robinhood rows must go, not stay on screen.
  await page.getByLabel('All chains').click();
  await page.getByRole('button', { name: /^Base/ }).click();
  await expect(page).toHaveURL(/chainId=8453/);
  await expect(page.getByText('No transactions yet.')).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(1);

  // The menu stays open after a pick; adding Robinhood Chain brings its trades back.
  await page.getByRole('button', { name: /Robinhood Chain/ }).click();
  await expect(table.getByRole('row')).toHaveCount(11);
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
  await page.getByRole('link', { name: /View pool MOCK1/ }).first().click();
  const history = page.getByRole('region', { name: 'Pool history' });
  await expect(history).toBeVisible();
  await expect(history.getByTestId('history-bar-unavailable')).toHaveCount(1);
  await history.getByRole('tab', { name: 'TVL' }).click();
  await expect(history.getByTestId('history-bar')).not.toHaveCount(0);
});
