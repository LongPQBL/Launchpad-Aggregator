// A trade panel's "Connect" button asks the header's WalletControl (always mounted) to open the
// wallet dialog it already owns — one dialog, no duplicated connector logic.
export const OPEN_WALLET_DIALOG_EVENT = 'open-wallet-dialog';
export const SWITCH_WALLET_NETWORK_EVENT = 'switch-wallet-network';

export function openWalletDialog(): void {
  window.dispatchEvent(new Event(OPEN_WALLET_DIALOG_EVENT));
}

export function requestWalletNetworkSwitch(chainId: number): void {
  window.dispatchEvent(new CustomEvent(SWITCH_WALLET_NETWORK_EVENT, { detail: { chainId } }));
}
