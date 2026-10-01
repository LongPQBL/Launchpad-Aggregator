'use client';

import { useEffect, useState } from 'react';
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { Button } from '@/components/ui/button';
import { robinhoodChain } from './config';

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

  if (status === 'reconnecting') return <Button type="button" variant="outline" disabled>Restoring wallet…</Button>;

  if (isConnected && address) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <span className="font-mono" title={address}>{shortAddress(address)}</span>
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
  return (
    <div className="relative text-sm">
      <Button type="button" aria-expanded={open} onClick={() => setOpen(!open)} disabled={connectPending}>
        {connectPending ? 'Connecting…' : 'Connect wallet'}
      </Button>
      {open && (
        <div role="group" aria-label="Browser wallets"
          className="absolute right-0 z-20 mt-2 min-w-52 rounded-md border border-border bg-card p-2 shadow-lg">
          {readyUids === null
            ? <p className="px-2 py-1 text-muted-foreground">Looking for browser wallets…</p>
            : available.length === 0
              ? <p className="px-2 py-1 text-muted-foreground">No browser wallet detected. Install a browser wallet to connect.</p>
              : available.map((connector) => (
                <Button key={connector.uid} type="button" variant="ghost" className="w-full justify-start"
                  disabled={connectPending} onClick={() => connect({ connector }, { onSuccess: () => setOpen(false) })}>
                  {connector.name}
                </Button>
              ))}
          {connectError && <p role="alert" className="px-2 py-1 text-destructive">{connectError.message}</p>}
        </div>
      )}
    </div>
  );
}
