'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { robinhoodChain } from './config';
import { OPEN_WALLET_DIALOG_EVENT } from './open-wallet-dialog';

const walletOptions = [
  { name: 'MetaMask', key: 'metamask' },
  { name: 'Phantom', key: 'phantom' },
] as const;

function WalletLogo({ wallet }: { wallet: (typeof walletOptions)[number]['key'] }) {
  const src = wallet === 'metamask' ? '/images/wallets/metamask.png' : '/images/wallets/phantom.png';
  return <Image aria-hidden="true" src={src} alt="" width={32} height={32} className="size-8 shrink-0 rounded object-contain" />;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletControl() {
  const { address, chainId, isConnected, status } = useAccount();
  const connectors = useConnectors();
  const { connect, error: connectError, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, error: switchError, isPending: switchPending } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [readyUids, setReadyUids] = useState<Set<string> | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all(connectors.filter((connector) => connector.type === 'injected').map(async (connector) => {
      try { return (await connector.getProvider()) ? connector.uid : null; }
      catch { return null; }
    })).then((uids) => {
      if (active) setReadyUids(new Set(uids.filter((uid): uid is string => uid !== null)));
    });
    return () => { active = false; };
  }, [connectors]);

  // A trade panel's Connect button asks for this dialog. Ignored while connected, so a request can
  // never leave `open` stuck true and pop the dialog up after a later disconnect.
  useEffect(() => {
    if (isConnected) return;
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
    return () => window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
  }, [isConnected]);

  if (status === 'reconnecting') return <Button type="button" variant="outline" disabled>Restoring wallet…</Button>;

  if (isConnected && address) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <span title={address}>{shortAddress(address)}</span>
        {chainId !== robinhoodChain.id && (
          <Button type="button" variant="outline" size="sm" disabled={switchPending}
            onClick={() => switchChain({ chainId: robinhoodChain.id })}>
            {switchPending ? 'Switching…' : 'Switch to Robinhood Chain'}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => disconnect()}>Disconnect</Button>
        {switchError && <p role="alert" className="w-full text-right text-destructive">{switchError.message}</p>}
      </div>
    );
  }

  const available = connectors.filter((connector) => readyUids?.has(connector.uid));
  const connectorForWallet = (wallet: (typeof walletOptions)[number]) =>
    available.find((connector) => connector.name.toLowerCase().includes(wallet.key));
  return (
    <div className="relative text-sm">
      <Button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} disabled={connectPending}
        className="cursor-pointer bg-[#ccff00] text-[#151515] hover:bg-[#bff000]">
        {connectPending ? 'Connecting…' : 'Connect'}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Connect a wallet">
        <div className="grid gap-2">
          {walletOptions.map((wallet) => {
            const connector = connectorForWallet(wallet);
            return (
              <Button key={wallet.key} type="button" variant="outline" className="h-14 w-full cursor-pointer justify-start gap-3 px-3"
                disabled={!connector || connectPending || readyUids === null}
                onClick={() => connector && connect({ connector }, { onSuccess: () => setOpen(false) })}>
                <WalletLogo wallet={wallet.key} />
                <span>{wallet.name}</span>
                {!connector && readyUids !== null && <span className="ml-auto text-xs text-muted-foreground">Not detected</span>}
              </Button>
            );
          })}
        </div>
        {readyUids === null && <p className="mt-2 text-xs text-muted-foreground">Looking for wallets…</p>}
        {connectError && <p role="alert" className="mt-3 text-sm text-destructive">{connectError.message}</p>}
      </Dialog>
    </div>
  );
}
