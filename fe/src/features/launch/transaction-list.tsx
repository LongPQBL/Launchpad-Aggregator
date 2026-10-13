'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { displaySymbol, formatActivityKind, formatAmount, formatSide } from '@/api/format';
import { getLaunchTransactions, type OfficialVenue, type Transaction } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { SIDE_OPTIONS, TypeFilter, type SideFilter } from '@/features/transactions/type-filter';
import { mergeRefreshedPage } from '@/lib/merge-refreshed-page';
import { TRADE_CREATED_EVENT } from '@/hooks/live-events';
import type { SseEventPayload } from '@/hooks/resource-keys';
import { formatRelativeTime, useNow } from '@/lib/relative-time';
import { RollingText } from '@/components/percent-change';
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
  /** Load further pages for one venue only (the bonding curve). */
  venue?: 'curve';
}

// Mirrors LaunchRowsSkeleton in launches/launch-list.tsx: pulsing placeholder rows in the table's own layout.
const SKELETON_CELL_COUNT = [0, 1, 2, 3, 4, 5, 6] as const;

function TransactionRowsSkeleton({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <TableRow key={index} aria-hidden="true" data-testid="transaction-skeleton-row" className="h-[52px] border-0 hover:bg-transparent">
      {SKELETON_CELL_COUNT.map((cell) => (
        <TableCell key={cell} className={cn(cell === 0 && 'pl-4')}>
          <span className="block h-4 w-full animate-pulse rounded bg-muted" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
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

const LIVE_FETCH_MIN_INTERVAL_MS = 1_000;

export function TransactionList({ transactions, tokenSymbol, quoteAsset, explorerBase, chainId, tokenAddress, nextCursor: initialCursor, venue }: TransactionListProps) {
  const now = useNow();
  const [items, setItems] = useState(transactions);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [sideFilter, setSideFilter] = useState<SideFilter[]>(['buy', 'sell']);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  // Merge the server-provided first page when it changes, keeping pages the user already loaded
  // (React's "adjust state during render" pattern).
  const [syncedSource, setSyncedSource] = useState({ transactions, initialCursor });
  if (syncedSource.transactions !== transactions || syncedSource.initialCursor !== initialCursor) {
    setSyncedSource({ transactions, initialCursor });
    const merged = mergeRefreshedPage(transactions, initialCursor ?? null, items, nextCursor,
      (row) => `${row.blockNumber}-${row.txHash}-${row.logIndex}`);
    setItems(merged.items);
    setNextCursor(merged.nextCursor);
    setLoadError(false);
  }

  // A trade announced for this token is fetched right away as a first-page merge, so the newest rows
  // appear without waiting for the page-wide router.refresh() (which is throttled and re-runs every
  // other fetch on the page). Leading + trailing throttle: a busy token costs at most one request a second.
  const latestRef = useRef({ items, nextCursor });
  useEffect(() => { latestRef.current = { items, nextCursor }; });
  useEffect(() => {
    if (chainId === undefined || !tokenAddress) return;
    let lastRun = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const run = async () => {
      lastRun = Date.now();
      try {
        const page = await getLaunchTransactions(chainId, tokenAddress, { venue });
        if (disposed) return;
        const { items: previous, nextCursor: previousCursor } = latestRef.current;
        const merged = mergeRefreshedPage(page.items, page.nextCursor, previous, previousCursor,
          (row) => `${row.blockNumber}-${row.txHash}-${row.logIndex}`);
        setItems(merged.items);
        setNextCursor(merged.nextCursor);
      } catch { /* the page-wide refresh and the fallback poll still catch up */ }
    };
    const onTradeCreated = (event: Event) => {
      const payload = (event as CustomEvent<SseEventPayload>).detail;
      if (payload.chainId !== chainId || payload.tokenAddress?.toLowerCase() !== tokenAddress.toLowerCase()) return;
      if (document.hidden || trailing !== null) return;
      const wait = LIVE_FETCH_MIN_INTERVAL_MS - (Date.now() - lastRun);
      if (wait <= 0) { void run(); return; }
      trailing = setTimeout(() => { trailing = null; void run(); }, wait);
    };
    window.addEventListener(TRADE_CREATED_EVENT, onTradeCreated);
    return () => {
      disposed = true;
      window.removeEventListener(TRADE_CREATED_EVENT, onTradeCreated);
      if (trailing !== null) clearTimeout(trailing);
    };
  }, [chainId, tokenAddress, venue]);

  const loadMore = useCallback(async () => {
    if (chainId === undefined || !tokenAddress || !nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = await getLaunchTransactions(chainId, tokenAddress, { cursor: nextCursor, venue });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [chainId, nextCursor, tokenAddress, venue]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || loadError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadError, loadMore, nextCursor]);

  const visibleItems = sideFilter.length === SIDE_OPTIONS.length ? items : items.filter((row) => (sideFilter as readonly string[]).includes(row.side));

  return (
    <>
    <Table aria-label="Transactions" className="table-fixed border-separate border-spacing-0">
      <TableHeader className="border-b-0 [&_tr]:!border-0">
        <TableRow className="h-10 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
          <TableHead className="w-[9%] pl-4">Time</TableHead>
          <TableHead className="w-[16%]"><TypeFilter options={SIDE_OPTIONS} selected={sideFilter} onChange={setSideFilter} /></TableHead>
          <TableHead className="w-[15%] text-right">{displaySymbol(tokenSymbol)}</TableHead>
          <TableHead className="w-[18%] text-right">For</TableHead>
          <TableHead className="w-[13%] text-right">USD</TableHead>
          <TableHead className="w-[14%] text-right">Wallet</TableHead>
          <TableHead className="w-[15%] text-right">Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleItems.map((row) => {
          const activityLabel = row.source === 'official' ? formatActivityKind(row.activityKind ?? '') : null;
          return (
            <TableRow key={`${row.blockNumber}-${row.txHash}-${row.logIndex}`} className="border-0 hover:bg-transparent">
              <TableCell className="pl-4 text-base text-foreground" title={new Date(row.timestamp * 1000).toLocaleString('en-US')}>
                <RollingText text={formatRelativeTime(row.timestamp, now)} />
              </TableCell>
              <TableCell className="text-base">
                <span className={cn(!activityLabel && row.side === 'buy' && 'text-success', !activityLabel && row.side === 'sell' && 'text-destructive')}>
                  {activityLabel ?? formatSide(row.side)}
                </span>
              </TableCell>
              <TableCell className="text-right text-base">{formatAmount(row.tokenAmount)}</TableCell>
              <TableCell className="text-right text-base">
                <span className="inline-flex items-center justify-end gap-1">
                  {formatAmount(row.quoteAmount)} <span className={quoteLabelIsAddress(row, quoteAsset) ? 'cursor-pointer' : undefined}>{quoteLabel(row, quoteAsset)}</span>
                  <TokenLogo logoUri={null} symbol={quoteLabel(row, quoteAsset)} chainId={chainId} size="transaction" />
                </span>
              </TableCell>
              <TableCell
                className="text-right text-base"
                title={row.usdValueStatus === 'priced' ? 'Converted at the historical quote price near this trade\'s own execution time, not the current price' : undefined}
              >
                {row.usdValueStatus === 'pending' ? 'Calculating…' : formatUsdAmount(row.usdValue)}
              </TableCell>
              <TableCell className="text-right text-base">
                {explorerBase ? (
                  <a href={`${explorerBase}/address/${row.traderAddress}`} target="_blank" rel="noreferrer noopener">
                    <span className="cursor-pointer">{shortAddress(row.traderAddress)}</span>
                  </a>
                ) : <span className="cursor-pointer">{shortAddress(row.traderAddress)}</span>}
              </TableCell>
              <TableCell className="text-right text-base">
                {explorerBase ? (
                  <a className="cursor-pointer" href={`${explorerBase}/tx/${row.txHash}`} target="_blank" rel="noreferrer noopener">
                    {shortAddress(row.txHash)}
                  </a>
                ) : <span className="cursor-pointer">{shortAddress(row.txHash)}</span>}
              </TableCell>
            </TableRow>
          );
        })}
        {loadingMore && <TransactionRowsSkeleton count={6} />}
      </TableBody>
    </Table>
      {items.length > 0 && visibleItems.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No transactions match this filter.</p>}
      {nextCursor && sideFilter.length > 0 && chainId !== undefined && tokenAddress && <div ref={sentinelRef} data-testid="transactions-load-more-sentinel" aria-hidden="true" className="h-px" />}
      {loadingMore && <p role="status" className="sr-only">Loading more transactions…</p>}
      {loadError && <div className="text-center text-sm"><span role="alert">Could not load more transactions. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
    </>
  );
}
