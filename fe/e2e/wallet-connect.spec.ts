import { expect, test } from './fixtures';

test('connects an injected wallet and switches to Robinhood Chain', async ({ page }) => {
  await page.addInitScript(() => {
    const address = '0x1234567890123456789012345678901234567890';
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let accounts: string[] = window.localStorage.getItem('e2e-wallet-authorized') ? [address] : [];
    let chainId = '0x1';
    const emit = (event: string, value: unknown) => listeners.get(event)?.forEach((listener) => listener(value));
    const provider = {
      isMetaMask: true,
      async request({ method, params }: { method: string; params?: [{ chainId: string }] }) {
        if (method === 'eth_accounts') return accounts;
        if (method === 'eth_requestAccounts') {
          accounts = [address];
          window.localStorage.setItem('e2e-wallet-authorized', '1');
          emit('accountsChanged', accounts);
          return accounts;
        }
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          chainId = params?.[0]?.chainId ?? chainId;
          emit('chainChanged', chainId);
          return null;
        }
        if (method === 'wallet_addEthereumChain') return null;
        throw new Error(`Unsupported wallet request: ${method}`);
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        const group = listeners.get(event) ?? new Set();
        group.add(listener);
        listeners.set(event, group);
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener);
      },
    };
    Object.defineProperty(window, 'ethereum', { configurable: true, value: provider });
  });

  await page.goto('/');
  expect(await page.evaluate(() => window.localStorage.getItem('e2e-wallet-authorized'))).toBeNull();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  const walletChoices = page.getByRole('group', { name: 'Browser wallets' });
  await walletChoices.getByRole('button').first().click();

  await expect(page.getByText('0x1234…7890')).toBeVisible();
  await page.getByRole('button', { name: 'Switch to Robinhood Chain' }).click();
  await expect(page.getByRole('button', { name: 'Switch to Robinhood Chain' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('0x1234…7890')).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
});
