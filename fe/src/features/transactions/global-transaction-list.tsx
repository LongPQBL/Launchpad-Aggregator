'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAddress } from 'viem';
import { chainExplorerBase } from '@/api/chains';
import { displaySymbol, formatActivityKind, formatAmount, formatUsdCompact } from '@/api/format';
import { getAllTransactions, launchHref, type GlobalTransaction } from '@/api/client';
import { quoteLogoUri } from '@/api/quote-logo';
import { ChainFilter } from '@/components/chain-filter';
import { PageHeading } from '@/components/page-heading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { TRANSACTION_COLUMNS, transactionColumnWidth } from '@/features/transactions/transaction-columns';
import { TypeFilter } from '@/features/transactions/type-filter';
import { mergeRefreshedPage } from '@/lib/merge-refreshed-page';
import { formatRelativeTime, useNow } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

export interface GlobalTransactionListProps {
  transactions: readonly GlobalTransaction[];
  nextCursor: string | null;
  /** Every chain that can be filtered on (the indexed chains). */
  chainIds?: readonly number[];
  /** Chains the server already filtered `transactions` by; empty = all. */
  selectedChainIds?: readonly number[];
  /** Page heading, shown on the same row as the chain filter. */
  heading?: string;
}

// Every row of this feed is a swap, so "Swap" is the only type to filter on (Uniswap also lists Add and Remove).
type TransactionType = 'swap';
const TYPE_OPTIONS: readonly { value: TransactionType; label: string }[] = [{ value: 'swap', label: 'Swap' }];


function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Wallets are shown in EIP-55 checksum form with three dots, like Uniswap's transactions table.
function walletLabel(address: string): string {
  try {
    const checksummed = getAddress(address);
    return `${checksummed.slice(0, 6)}...${checksummed.slice(-4)}`;
  } catch {
    return shortAddress(address);
  }
}

function rowKey(row: GlobalTransaction): string {
  return `${row.blockNumber}-${row.txHash}-${row.logIndex}`;
}

function SkeletonRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <TableRow key={index} aria-hidden="true" data-testid="global-transaction-skeleton-row" className="h-[60px] border-0 hover:bg-transparent">
      {TRANSACTION_COLUMNS.map((_, cell) => (
        <TableCell key={cell} className={cn(cell === 0 && 'pl-4', cell === TRANSACTION_COLUMNS.length - 1 && 'pr-4')}>
          <span className="block h-4 w-full animate-pulse rounded bg-muted" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

// One side of a swap: the asset's logo and symbol (or its amount, in the amount columns).
function AssetSide({ symbol, logoUri, chainId, address }: { symbol: string; logoUri: string | null; chainId: number; address?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-foreground">{symbol}</span>
      <TokenLogo logoUri={address ? quoteLogoUri(address, logoUri) : logoUri} symbol={symbol} chainId={chainId} size="small" />
    </span>
  );
}

// The newest trades across every launch (Explore > Transactions). Same behaviours as a single launch's
// transaction table: infinite scroll, merge-not-reset on a server refresh, skeleton rows while loading.
export function GlobalTransactionList({ transactions, nextCursor: initialCursor, chainIds = [], selectedChainIds = [], heading }: GlobalTransactionListProps) {
  const now = useNow();
  const [items, setItems] = useState(transactions);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor);
  const [selectedChains, setSelectedChains] = useState<readonly number[]>(selectedChainIds);
  const [chainMenuOpen, setChainMenuOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TransactionType[]>(['swap']);
  const [filtering, setFiltering] = useState(false);
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

  const chainQuery = selectedChains.length > 0 ? selectedChains : undefined;

  const changeChains = useCallback(async (values: number[]) => {
    setSelectedChains(values);
    setFiltering(true);
    setLoadError(false);
    const url = new URL(window.location.href);
    if (values.length > 0) url.searchParams.set('chainId', values.join(','));
    else url.searchParams.delete('chainId');
    window.history.replaceState(null, '', url);
    try {
      const page = await getAllTransactions({ chainId: values.length > 0 ? values : undefined });
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      setFiltering(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = await getAllTransactions({ cursor: nextCursor, chainId: chainQuery });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor, chainQuery]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || loadError || filtering || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filtering, loadError, loadMore, nextCursor]);

  const visibleItems = typeFilter.includes('swap') ? items : [];

  return (
    <>
      {(heading || chainIds.length > 0) && (
        <PageHeading title={heading ?? ''}>
          {chainIds.length > 0 && (
            <ChainFilter chainIds={chainIds} selected={selectedChains} onChange={(values) => { void changeChains(values); }}
              open={chainMenuOpen} onToggle={() => setChainMenuOpen((open) => !open)} />
          )}
        </PageHeading>
      )}
      <Table aria-label="Latest transactions" className="table-fixed border-separate border-spacing-0">
        <TableHeader className="border-b-0 [&_tr]:!border-0">
          <TableRow className="h-12 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
            <TableHead style={{ width: transactionColumnWidth(0) }} className="pl-4">Time</TableHead>
            <TableHead style={{ width: transactionColumnWidth(1) }}><TypeFilter options={TYPE_OPTIONS} selected={typeFilter} onChange={setTypeFilter} /></TableHead>
            <TableHead style={{ width: transactionColumnWidth(2) }} className="text-right">USD</TableHead>
            <TableHead style={{ width: transactionColumnWidth(3) }} className="text-right">Token amount</TableHead>
            <TableHead style={{ width: transactionColumnWidth(4) }} className="text-right">Token amount</TableHead>
            <TableHead style={{ width: transactionColumnWidth(5) }} className="text-right">Wallet</TableHead>
            <TableHead style={{ width: transactionColumnWidth(6) }} className="pr-4 text-right">Explorer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!filtering && visibleItems.map((row) => {
            // Each row links to its own chain's explorer, so the feed keeps working when a second chain is indexed.
            const explorerBase = chainExplorerBase(row.token.chainId);
            const tokenSymbol = displaySymbol(row.token.symbol);
            const quoteSymbol = row.quoteAsset.symbol ?? shortAddress(row.quoteAsset.address);
            const tokenSide = { symbol: tokenSymbol, logoUri: row.token.logoUri, chainId: row.token.chainId };
            const quoteSide = { symbol: quoteSymbol, logoUri: row.quoteAsset.logoUri, chainId: row.token.chainId, address: row.quoteAsset.address };
            // A buy pays the quote asset for the launch token; a sell is the reverse. The first amount column is what
            // went out, the second what came in, as in Uniswap's table.
            const [sold, received] = row.side === 'buy' ? [quoteSide, tokenSide] : [tokenSide, quoteSide];
            const [soldAmount, receivedAmount] = row.side === 'buy' ? [row.quoteAmount, row.tokenAmount] : [row.tokenAmount, row.quoteAmount];
            const activity = row.activityKind ? formatActivityKind(row.activityKind) : null;
            const tokenPart = (side: typeof tokenSide & { address?: string }) => (side === tokenSide
              ? <Link href={launchHref(row.token.chainId, row.token.tokenAddress)} className="hover:underline"><AssetSide {...side} /></Link>
              : <AssetSide {...side} />);
            return (
              <TableRow key={rowKey(row)} className="h-[60px] border-0 hover:bg-transparent">
                <TableCell className="pl-4 text-base text-muted-foreground" title={new Date(row.timestamp * 1000).toLocaleString('en-US')}>
                  {formatRelativeTime(row.timestamp, now)}
                </TableCell>
                <TableCell className="text-base">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-muted-foreground">{activity ?? 'Swap'}</span>
                    {tokenPart(sold)}
                    <span className="text-muted-foreground">for</span>
                    {tokenPart(received)}
                  </span>
                </TableCell>
                <TableCell className="text-right text-base">
                  {row.usdValueStatus === 'pending' ? 'Calculating…' : row.usdValue === null ? '—' : formatUsdCompact(row.usdValue, 2)}
                </TableCell>
                {[[soldAmount, sold], [receivedAmount, received]].map(([amount, side], index) => (
                  <TableCell key={index} className="text-right text-base">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <span>{formatAmount(amount as string | null)}</span>
                      <AssetSide {...(side as typeof tokenSide)} />
                    </span>
                  </TableCell>
                ))}
                <TableCell className="text-right text-base">
                  {explorerBase
                    ? <a href={`${explorerBase}/address/${row.traderAddress}`} target="_blank" rel="noreferrer noopener">{walletLabel(row.traderAddress)}</a>
                    : walletLabel(row.traderAddress)}
                </TableCell>
                <TableCell className="pr-4 text-right text-base">
                  {explorerBase
                    ? <a href={`${explorerBase}/tx/${row.txHash}`} target="_blank" rel="noreferrer noopener">{shortAddress(row.txHash)}</a>
                    : shortAddress(row.txHash)}
                </TableCell>
              </TableRow>
            );
          })}
          {(filtering || loadingMore) && <SkeletonRows count={filtering ? 8 : 6} />}
        </TableBody>
      </Table>
      {!filtering && items.length > 0 && visibleItems.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No transactions match this filter.</p>}
      {!filtering && items.length === 0 && !loadError && <p role="status" className="py-6 text-center text-sm text-muted-foreground">No transactions yet.</p>}
      {nextCursor && !filtering && <div ref={sentinelRef} data-testid="global-transactions-sentinel" aria-hidden="true" className="h-px" />}
      {(loadingMore || filtering) && <p role="status" className="sr-only">Loading transactions…</p>}
      {loadError && <div className="text-center text-sm"><span role="alert">Could not load transactions. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
    </>
  );
}
