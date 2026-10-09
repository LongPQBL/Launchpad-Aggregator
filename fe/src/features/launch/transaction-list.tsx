'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { displaySymbol, formatActivityKind, formatAmount, formatSide } from '@/api/format';
import { getLaunchTransactions, type OfficialVenue, type Transaction } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { cn } from '@/lib/utils';

export interface TransactionListProps {
  transactions: readonly Transaction[];
  venues: readonly OfficialVenue[];
  tokenSymbol: string | null;
  quoteAsset: { address: string; symbol: string | null };
  explorerBase?: string;
  chainId?: number;
  tokenAddress?: string;
  nextCursor?: string | null;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TICK_INTERVAL_MS = 1_000;

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Ticks the Time column forward live (e.g. "10s" -> "11s") without needing a full data refresh —
// mirrors formatAge in launch-list.tsx / poolAge in pool-list.tsx but adds the re-render clock those
// don't need, since a launch/pool row's age is read once per page load rather than watched live.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function formatRelativeTime(timestampSeconds: number, nowMs: number): string {
  const diffSeconds = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);
  if (diffSeconds < 60) return `${diffSeconds}s`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diffSeconds / 3600);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(diffSeconds / 86_400)}d`;
}

// Pool quote assets vary per pool and this endpoint doesn't resolve arbitrary ERC20 symbols — same
// convention fe/src/features/pools/pool-list.tsx already uses: ETH for the zero address, otherwise
// a truncated address. The official venue's own quote asset DOES have a real resolved symbol
// (quoteAsset.symbol, from core-metadata enrichment), so that row type stays more precise.
function quoteLabel(row: Transaction, launchQuoteAsset: { address: string; symbol: string | null }): string {
  if (row.quoteAssetAddress === launchQuoteAsset.address) return displaySymbol(launchQuoteAsset.symbol);
  if (row.quoteAssetAddress === ZERO_ADDRESS) return 'ETH';
  return row.quoteAssetAddress ? shortAddress(row.quoteAssetAddress) : '—';
}

function quoteLabelIsAddress(row: Transaction, launchQuoteAsset: { address: string; symbol: string | null }): boolean {
  return Boolean(row.quoteAssetAddress && row.quoteAssetAddress !== launchQuoteAsset.address && row.quoteAssetAddress !== ZERO_ADDRESS);
}

// formatAmount's own '—' null case stays prefix-free — only an actual amount gets a '$'.
function formatUsdAmount(value: string | null): string {
  const formatted = formatAmount(value);
  return value === null ? formatted : `$${formatted}`;
}

export function TransactionList({ transactions, tokenSymbol, quoteAsset, explorerBase, chainId, tokenAddress, nextCursor: initialCursor }: TransactionListProps) {
  const now = useNow();
  const [items, setItems] = useState(transactions);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  // Reset to the server-provided page when it changes (React's "adjust state during render" pattern).
  const [syncedSource, setSyncedSource] = useState({ transactions, initialCursor });
  if (syncedSource.transactions !== transactions || syncedSource.initialCursor !== initialCursor) {
    setSyncedSource({ transactions, initialCursor });
    setItems(transactions);
    setNextCursor(initialCursor ?? null);
    setLoadError(false);
  }

  const loadMore = useCallback(async () => {
    if (chainId === undefined || !tokenAddress || !nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = await getLaunchTransactions(chainId, tokenAddress, { cursor: nextCursor });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [chainId, nextCursor, tokenAddress]);

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
    <Table aria-label="Transactions" className="border-separate border-spacing-0">
      <TableHeader className="border-b-0 [&_tr]:!border-0">
        <TableRow className="h-10 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
          <TableHead className="pl-4">Time</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">{displaySymbol(tokenSymbol)}</TableHead>
          <TableHead className="text-right">For</TableHead>
          <TableHead className="text-right">USD</TableHead>
          <TableHead className="text-right">Wallet</TableHead>
          <TableHead className="text-right">Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((row) => {
          const activityLabel = row.source === 'official' ? formatActivityKind(row.activityKind ?? '') : null;
          return (
            <TableRow key={`${row.blockNumber}-${row.txHash}-${row.logIndex}`} className="border-0 hover:bg-transparent">
              <TableCell className="pl-4 text-base font-semibold text-foreground" title={new Date(row.timestamp * 1000).toLocaleString('en-US')}>
                {formatRelativeTime(row.timestamp, now)}
              </TableCell>
              <TableCell className="text-base font-semibold">
                <span className={cn('font-semibold', !activityLabel && row.side === 'buy' && 'text-success', !activityLabel && row.side === 'sell' && 'text-destructive')}>
                  {activityLabel ?? formatSide(row.side)}
                </span>
                {row.source === 'pool' && <span className="ml-1 text-xs text-muted-foreground">(pool)</span>}
              </TableCell>
              <TableCell className="text-right text-base font-semibold">{formatAmount(row.tokenAmount)}</TableCell>
              <TableCell className="text-right text-base font-semibold">
                <span className="inline-flex items-center justify-end gap-1">
                  {formatAmount(row.quoteAmount)} <span className={quoteLabelIsAddress(row, quoteAsset) ? 'cursor-pointer' : undefined}>{quoteLabel(row, quoteAsset)}</span>
                  <TokenLogo logoUri={null} symbol={quoteLabel(row, quoteAsset)} chainId={chainId} />
                </span>
              </TableCell>
              <TableCell
                className="text-right text-base font-semibold"
                title={row.usdValueStatus === 'priced' ? 'Converted at the historical quote price near this trade\'s own execution time, not the current price' : undefined}
              >
                {row.usdValueStatus === 'pending' ? 'Calculating…' : formatUsdAmount(row.usdValue)}
              </TableCell>
              <TableCell className="text-right text-base font-semibold">
                {explorerBase ? (
                  <a href={`${explorerBase}/address/${row.traderAddress}`} target="_blank" rel="noreferrer noopener">
                    <span className="cursor-pointer">{shortAddress(row.traderAddress)}</span>
                  </a>
                ) : <span className="cursor-pointer">{shortAddress(row.traderAddress)}</span>}
              </TableCell>
              <TableCell className="text-right text-base font-semibold">
                {explorerBase ? (
                  <a className="cursor-pointer" href={`${explorerBase}/tx/${row.txHash}`} target="_blank" rel="noreferrer noopener">
                    {shortAddress(row.txHash)}
                  </a>
                ) : <span className="cursor-pointer">{shortAddress(row.txHash)}</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
      {nextCursor && chainId !== undefined && tokenAddress && <div ref={sentinelRef} data-testid="transactions-load-more-sentinel" aria-hidden="true" className="h-px" />}
      {loadingMore && <p role="status" className="text-center text-sm text-muted-foreground">Loading more transactions…</p>}
      {loadError && <div className="text-center text-sm"><span role="alert">Could not load more transactions. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
    </>
  );
}
