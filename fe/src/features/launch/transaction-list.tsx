'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { displaySymbol, formatActivityKind, formatAmount, formatSide } from '@/api/format';
import { getLaunchTransactions, type OfficialVenue, type Transaction } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { mergeRefreshedPage } from '@/lib/merge-refreshed-page';
import { formatRelativeTime, useNow } from '@/lib/relative-time';
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

type SideFilter = 'buy' | 'sell';
const SIDE_OPTIONS: readonly { value: SideFilter; label: string }[] = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
];

function UpDownIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M4.5 6.5 8 3l3.5 3.5" /><path d="M4.5 9.5 8 13l3.5-3.5" />
    </svg>
  );
}

// Every type starts selected; clicking an option toggles it. Deselecting everything is allowed and shows nothing.
function TypeFilter({ selected, onChange }: { selected: readonly SideFilter[]; onChange: (values: SideFilter[]) => void }) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggle = (value: SideFilter) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <>
      <button ref={buttonRef} type="button" aria-haspopup="true" aria-expanded={open} aria-label="Filter by type"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setMenuPosition({ top: rect.bottom + 8, left: rect.left });
          setOpen((v) => !v);
        }}
        className="inline-flex cursor-pointer items-center gap-1.5 font-medium">
        <UpDownIcon />
        Type
      </button>
      {/* Portaled with fixed positioning: the table's overflow-x-auto container would otherwise clip the menu when the table is short (e.g. nothing selected). */}
      {open && menuPosition && createPortal(
        <div ref={menuRef} role="menu" aria-label="Type filter" style={{ top: menuPosition.top, left: menuPosition.left }} className="fixed z-50 w-40 rounded-lg border border-border bg-card p-1 text-foreground shadow-md">
          {SIDE_OPTIONS.map(({ value, label }) => (
            <button key={value} type="button" onClick={() => toggle(value)} aria-pressed={selected.includes(value)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm font-normal hover:bg-muted">
              {label} {selected.includes(value) && <SelectedCheck />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function SelectedCheck() {
  return (
    <span data-selected-check className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/20 text-brand">
      <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>
    </span>
  );
}

// Mirrors LaunchRowsSkeleton in launches/launch-list.tsx: pulsing placeholder rows in the table's own layout.
const SKELETON_CELL_WIDTHS = ['w-10', 'w-14', 'w-16', 'w-24', 'w-12', 'w-20', 'w-20'] as const;

function TransactionRowsSkeleton({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <TableRow key={index} aria-hidden="true" data-testid="transaction-skeleton-row" className="h-[52px] border-0 hover:bg-transparent">
      {SKELETON_CELL_WIDTHS.map((width, cell) => (
        <TableCell key={cell} className={cn(cell === 0 && 'pl-4', cell > 1 && 'text-right')}>
          <span className={cn('block h-4 animate-pulse rounded bg-muted', cell > 1 && 'ml-auto', width)} />
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

export function TransactionList({ transactions, tokenSymbol, quoteAsset, explorerBase, chainId, tokenAddress, nextCursor: initialCursor }: TransactionListProps) {
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

  const visibleItems = sideFilter.length === SIDE_OPTIONS.length ? items : items.filter((row) => (sideFilter as readonly string[]).includes(row.side));

  return (
    <>
    <Table aria-label="Transactions" className="table-fixed border-separate border-spacing-0">
      <TableHeader className="border-b-0 [&_tr]:!border-0">
        <TableRow className="h-10 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
          <TableHead className="w-[9%] pl-4">Time</TableHead>
          <TableHead className="w-[16%]"><TypeFilter selected={sideFilter} onChange={setSideFilter} /></TableHead>
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
