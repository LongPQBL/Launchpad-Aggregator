import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletControl } from './wallet-control';
import { openWalletDialog } from './open-wallet-dialog';

const hooks = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, chainId: undefined as number | undefined, isConnected: false, status: 'disconnected' },
  connectors: [] as { uid: string; name: string; type: string; getProvider: () => Promise<object | undefined> }[],
  connect: vi.fn(), disconnect: vi.fn(), switchChain: vi.fn(),
  connectError: null as Error | null, switchError: null as Error | null,
  connectPending: false, switchPending: false,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useConnectors: () => hooks.connectors,
  useConnect: () => ({ connect: hooks.connect, error: hooks.connectError, isPending: hooks.connectPending }),
  useDisconnect: () => ({ disconnect: hooks.disconnect }),
  useSwitchChain: () => ({ switchChain: hooks.switchChain, error: hooks.switchError, isPending: hooks.switchPending }),
}));

beforeEach(() => {
  hooks.account = { address: undefined, chainId: undefined, isConnected: false, status: 'disconnected' };
  hooks.connectors = [];
  hooks.connectError = null;
  hooks.switchError = null;
  hooks.connectPending = false;
  hooks.switchPending = false;
  hooks.connect.mockReset();
  hooks.disconnect.mockReset();
  hooks.switchChain.mockReset();
});

describe('WalletControl', () => {
  it('opens the connect dialog when a trade panel asks for it', () => {
    render(<WalletControl />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => openWalletDialog());
    expect(screen.getByRole('dialog', { name: 'Connect a wallet' })).toBeInTheDocument();
  });

  it('ignores that request while a wallet is already connected', () => {
    hooks.account = { address: '0x1111111111111111111111111111111111111111', chainId: 4663, isConnected: true, status: 'connected' };
    render(<WalletControl />);
    act(() => openWalletDialog());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains when no browser wallet is detected', async () => {
    render(<WalletControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(await screen.findByText(/No browser wallet detected/)).toBeInTheDocument();
  });

  it('waits for browser wallet discovery before saying none is installed', async () => {
    let finishDiscovery!: (provider: object) => void;
    hooks.connectors = [{ uid: 'late-wallet', name: 'Late Wallet', type: 'injected',
      getProvider: () => new Promise((resolve) => { finishDiscovery = resolve; }) }];
    render(<WalletControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByText('Looking for browser wallets…')).toBeInTheDocument();
    expect(screen.queryByText(/No browser wallet detected/)).not.toBeInTheDocument();
    finishDiscovery({});
    expect(await screen.findByRole('button', { name: 'Late Wallet' })).toBeInTheDocument();
  });

  it('offers each detected browser wallet and connects only after selection', async () => {
    const metamask = { uid: 'metamask', name: 'MetaMask', type: 'injected', getProvider: async () => ({}) };
    const rabby = { uid: 'rabby', name: 'Rabby', type: 'injected', getProvider: async () => ({}) };
    hooks.connectors = [metamask, rabby];
    render(<WalletControl />);
    expect(hooks.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'MetaMask' }));
    expect(hooks.connect).toHaveBeenCalledWith({ connector: metamask }, expect.any(Object));
    expect(screen.getByRole('button', { name: 'Rabby' })).toBeInTheDocument();
  });

  it('shows the connected address and disconnects', () => {
    hooks.account = { address: '0x1234567890123456789012345678901234567890', chainId: 4663,
      isConnected: true, status: 'connected' };
    render(<WalletControl />);
    expect(screen.getByText('0x1234…7890')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to Robinhood Chain' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(hooks.disconnect).toHaveBeenCalledOnce();
  });

  it('offers a network switch while connected to another chain', () => {
    hooks.account = { address: '0x1234567890123456789012345678901234567890', chainId: 1,
      isConnected: true, status: 'connected' };
    render(<WalletControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Robinhood Chain' }));
    expect(hooks.switchChain).toHaveBeenCalledWith({ chainId: 4663 });
  });

  it('shows rejected connection and switch requests without losing the account', async () => {
    hooks.connectError = new Error('User rejected the request');
    const view = render(<WalletControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('User rejected the request');

    hooks.account = { address: '0x1234567890123456789012345678901234567890', chainId: 1,
      isConnected: true, status: 'connected' };
    hooks.connectError = null;
    hooks.switchError = new Error('Could not add network');
    view.rerender(<WalletControl />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not add network'));
    expect(screen.getByText('0x1234…7890')).toBeInTheDocument();
  });
});
