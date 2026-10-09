'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { useAccount, useReadContracts } from 'wagmi';
import { getWalletPositions, launchHref, type WalletPosition } from '@/api/client';
import { displayName, displaySymbol, formatAmount, formatUsdCompact } from '@/api/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { erc20Abi } from '@/trading/erc20Abi';
import { cn } from '@/lib/utils';

const SKELETON_CELLS = [0, 1, 2, 3, 4, 5] as const;

interface Row { position: WalletPosition; balance: string | null; valueUsd: number | null }

function SkeletonRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <TableRow key={index} aria-hidden="true" data-testid="portfolio-skeleton-row" className="h-[52px] border-0 hover:bg-transparent">
      {SKELETON_CELLS.map((cell) => (
        <TableCell key={cell} className={cn(cell === 0 && 'pl-4')}>
          <span className="block h-4 w-full animate-pulse rounded bg-muted" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

// Read-only portfolio: the launches the connected wallet has traded on the indexed venues (from the API),
// with the wallet's current balance of each read straight from the chain. No signing, no custody.
export function PortfolioView() {
  const { address } = useAccount();
  // Tagged with the wallet they were fetched for, so switching wallets never shows the previous wallet's tokens.
  const [loaded, setLoaded] = useState<{ address: string; items: readonly WalletPosition[] } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [hideZero, setHideZero] = useState(true);

  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the request start for the loading skeleton; nothing else drives this transition
    setStatus('loading');
    getWalletPositions(address, controller.signal)
      .then((result) => { setLoaded({ address, items: result.items }); setStatus('idle'); })
      .catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [address]);

  const visiblePositions = address && loaded?.address === address ? loaded.items : null;
  const balances = useReadContracts({
    contracts: (visiblePositions ?? []).map((position) => ({
      address: position.token.tokenAddress as Address, abi: erc20Abi, functionName: 'balanceOf' as const,
      args: [address as Address] as const, chainId: position.token.chainId,
    })),
    query: { enabled: Boolean(address && visiblePositions && visiblePositions.length > 0) },
  });

  const rows: Row[] = useMemo(() => (visiblePositions ?? []).map((position, index) => {
    const result = balances.data?.[index];
    const raw = result?.status === 'success' ? (result.result as bigint) : null;
    const balance = raw !== null && position.token.decimals !== null ? formatUnits(raw, position.token.decimals) : null;
    const valueUsd = balance !== null && position.priceUsd !== null ? Number(balance) * Number(position.priceUsd) : null;
    return { position, balance, valueUsd };
  }), [visiblePositions, balances.data]);

  if (!address) {
    return <p role="status" className="py-10 text-center text-muted-foreground">Connect your wallet to see the launches you have traded.</p>;
  }

  const shown = hideZero ? rows.filter((row) => row.balance === null || Number(row.balance) > 0) : rows;
  const priced = rows.filter((row) => row.valueUsd !== null);
  const totalUsd = priced.reduce((sum, row) => sum + (row.valueUsd ?? 0), 0);
  const unpricedHeld = rows.some((row) => row.valueUsd === null && row.balance !== null && Number(row.balance) > 0);
  const loading = status === 'loading' && visiblePositions === null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Total value</p>
          <p className="text-3xl font-semibold" data-testid="portfolio-total">{priced.length > 0 ? formatUsdCompact(String(totalUsd), 2) : '—'}</p>
          {unpricedHeld && <p className="text-xs text-muted-foreground">Excludes tokens without a USD price.</p>}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={hideZero} onChange={(event) => setHideZero(event.target.checked)} />
          Hide zero balances
        </label>
      </div>
      {status === 'error' && <p role="alert">Could not load your positions. Please try again.</p>}
      <Table aria-label="Portfolio" className="table-fixed border-separate border-spacing-0">
        <TableHeader className="border-b-0 [&_tr]:!border-0">
          <TableRow className="h-10 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
            <TableHead className="w-[30%] pl-4">Token</TableHead>
            <TableHead className="w-[14%] text-right">Balance</TableHead>
            <TableHead className="w-[14%] text-right">Price</TableHead>
            <TableHead className="w-[14%] text-right">Value</TableHead>
            <TableHead className="w-[10%] text-right">Trades</TableHead>
            <TableHead className="w-[18%] text-right">Spent / received</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map(({ position, balance, valueUsd }) => (
            <TableRow key={`${position.token.chainId}:${position.token.tokenAddress}`} className="border-0 hover:bg-transparent">
              <TableCell className="pl-4 text-base font-semibold">
                <Link href={launchHref(position.token.chainId, position.token.tokenAddress)} className="flex items-center gap-2 hover:underline">
                  <TokenLogo logoUri={position.token.logoUri} symbol={displaySymbol(position.token.symbol)} chainId={position.token.chainId} />
                  <span className="min-w-0"><span className="block truncate">{displayName(position.token.name, position.token.tokenAddress)}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{displaySymbol(position.token.symbol)}</span></span>
                </Link>
              </TableCell>
              <TableCell className="text-right text-base font-semibold">{balance === null ? '—' : formatAmount(balance)}</TableCell>
              <TableCell className="text-right text-base font-semibold">{position.priceUsd === null ? '—' : formatUsdCompact(position.priceUsd, 2)}</TableCell>
              <TableCell className="text-right text-base font-semibold">{valueUsd === null ? '—' : formatUsdCompact(String(valueUsd), 2)}</TableCell>
              <TableCell className="text-right text-base font-semibold" title={`${position.buyCount} buys, ${position.sellCount} sells`}>{position.tradeCount}</TableCell>
              <TableCell className="text-right text-sm font-semibold">
                {position.quoteSpent === null || position.quoteReceived === null ? '—'
                  : `${formatAmount(position.quoteSpent)} / ${formatAmount(position.quoteReceived)} ${displaySymbol(position.quoteAsset.symbol)}`}
              </TableCell>
            </TableRow>
          ))}
          {loading && <SkeletonRows count={6} />}
        </TableBody>
      </Table>
      {!loading && status !== 'error' && shown.length === 0 && (
        <p role="status" className="py-6 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? 'No trades from this wallet on the indexed venues yet.' : 'No tokens with a balance. Untick “Hide zero balances” to see past trades.'}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Balances are read from the chain. Trades, spent and received come from official venue trades attributed to this wallet; transfers in or out are not tracked.
      </p>
    </div>
  );
}
