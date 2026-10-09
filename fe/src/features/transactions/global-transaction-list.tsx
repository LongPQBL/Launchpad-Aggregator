'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { displaySymbol, formatActivityKind, formatAmount, formatSide } from '@/api/format';
import { chainExplorerBase } from '@/api/chains';
import { getAllTransactions, launchHref, type GlobalTransaction } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { mergeRefreshedPage } from '@/lib/merge-refreshed-page';
import { formatRelativeTime, useNow } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

export interface GlobalTransactionListProps {
  transactions: readonly GlobalTransaction[];
  nextCursor: string | null;
}

const SKELETON_WIDTHS = ['w-10', 'w-28', 'w-14', 'w-16', 'w-20', 'w-14', 'w-20', 'w-20'] as const;

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function rowKey(row: GlobalTransaction): string {
  return `${row.blockNumber}-${row.txHash}-${row.logIndex}`;
}

function SkeletonRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <TableRow key={index} aria-hidden="true" data-testid="global-transaction-skeleton-row" className="h-[52px] border-0 hover:bg-transparent">
      {SKELETON_WIDTHS.map((width, cell) => (
        <TableCell key={cell} className={cn(cell === 0 && 'pl-4', cell > 1 && 'text-right')}>
          <span className={cn('block h-4 animate-pulse rounded bg-muted', cell > 1 && 'ml-auto', width)} />
        </TableCell>
      ))}
    </TableRow>
  ));
}

// The newest official trades across every launch (Explore > Transactions). Same behaviours as a single
// launch's transaction table: infinite scroll, merge-not-reset on a server refresh, skeleton rows while loading.
export function GlobalTransactionList({ transactions, nextCursor: initialCursor }: GlobalTransactionListProps) {
  const now = useNow();
  const [items, setItems] = useState(transactions);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const [synced, setSynced] = useState({ transactions, initialCursor });
  if (synced.transactions !== transactions || synced.initialCursor !== initialCursor) {
    setSynced({ transactions, initialCursor });
    const merged = mergeRefreshedPage(transactions, initialCursor, items, nextCursor, rowKey);
    setItems(merged.items);
    setNextCursor(merged.nextCursor);
    setLoadError(false);
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = await getAllTransactions({ cursor: nextCursor });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || loadError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadError, loadMore, nextCursor]);

  return (
    <>
      <Table aria-label="Latest transactions" className="table-fixed border-separate border-spacing-0">
        <TableHeader className="border-b-0 [&_tr]:!border-0">
          <TableRow className="h-10 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
            <TableHead className="w-[7%] pl-4">Time</TableHead>
            <TableHead className="w-[19%]">Token</TableHead>
            <TableHead className="w-[9%]">Type</TableHead>
            <TableHead className="w-[14%] text-right">Amount</TableHead>
            <TableHead className="w-[16%] text-right">For</TableHead>
            <TableHead className="w-[10%] text-right">USD</TableHead>
            <TableHead className="w-[12%] text-right">Wallet</TableHead>
            <TableHead className="w-[13%] text-right">Explorer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((row) => {
            // Each row links to its own chain's explorer, so the feed keeps working when a second chain is indexed.
            const explorerBase = chainExplorerBase(row.token.chainId);
            return (
            <TableRow key={rowKey(row)} className="border-0 hover:bg-transparent">
              <TableCell className="pl-4 text-base font-semibold" title={new Date(row.timestamp * 1000).toLocaleString('en-US')}>
                {formatRelativeTime(row.timestamp, now)}
              </TableCell>
              <TableCell className="text-base font-semibold">
                <Link href={launchHref(row.token.chainId, row.token.tokenAddress)} className="flex items-center gap-2 hover:underline">
                  <TokenLogo logoUri={row.token.logoUri} symbol={displaySymbol(row.token.symbol)} chainId={row.token.chainId} />
                  <span className="truncate">{displaySymbol(row.token.symbol)}</span>
                </Link>
              </TableCell>
              <TableCell className="text-base font-semibold">
                <span className={cn(row.side === 'buy' && 'text-success', row.side === 'sell' && 'text-destructive')}>
                  {(row.activityKind && formatActivityKind(row.activityKind)) || formatSide(row.side)}
                </span>
                {row.source === 'pool' && <span className="ml-1 text-xs text-muted-foreground">(pool)</span>}
              </TableCell>
              <TableCell className="text-right text-base font-semibold">{formatAmount(row.tokenAmount)}</TableCell>
              <TableCell className="text-right text-base font-semibold">{formatAmount(row.quoteAmount)} {row.quoteAsset.symbol ?? shortAddress(row.quoteAsset.address)}</TableCell>
              <TableCell className="text-right text-base font-semibold">
                {row.usdValueStatus === 'pending' ? 'Calculating…' : row.usdValue === null ? '—' : `$${formatAmount(row.usdValue)}`}
              </TableCell>
              <TableCell className="text-right text-base font-semibold">
                {explorerBase
                  ? <a href={`${explorerBase}/address/${row.traderAddress}`} target="_blank" rel="noreferrer noopener">{shortAddress(row.traderAddress)}</a>
                  : shortAddress(row.traderAddress)}
              </TableCell>
              <TableCell className="text-right text-base font-semibold">
                {explorerBase
                  ? <a href={`${explorerBase}/tx/${row.txHash}`} target="_blank" rel="noreferrer noopener">{shortAddress(row.txHash)}</a>
                  : shortAddress(row.txHash)}
              </TableCell>
            </TableRow>
            );
          })}
          {loadingMore && <SkeletonRows count={6} />}
        </TableBody>
      </Table>
      {items.length === 0 && <p role="status" className="py-6 text-center text-sm text-muted-foreground">No transactions yet.</p>}
      {nextCursor && <div ref={sentinelRef} data-testid="global-transactions-sentinel" aria-hidden="true" className="h-px" />}
      {loadingMore && <p role="status" className="sr-only">Loading more transactions…</p>}
      {loadError && <div className="text-center text-sm"><span role="alert">Could not load more transactions. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
    </>
  );
}
