import { describe, expect, it, vi } from 'vitest';
import { OPEN_WALLET_DIALOG_EVENT, openWalletDialog } from './open-wallet-dialog';

describe('openWalletDialog', () => {
  it('dispatches the open-wallet-dialog event on window', () => {
    const handler = vi.fn();
    window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
    openWalletDialog();
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
  });
});
