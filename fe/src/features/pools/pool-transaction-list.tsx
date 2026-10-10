'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { displaySymbol, formatAmount, formatSide } from '@/api/format';
import type { PoolTrade } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatRelativeTime, useNow } from '@/lib/relative-time';
import { RollingText } from '@/components/percent-change';
import { cn } from '@/lib/utils';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// decimals unknown (API returned null) shows '—' rather than guessing a magnitude for a raw
// integer amount — same rule as everywhere else on this page.
function formatRawAmount(raw: string, decimals: number | null): string {
  if (decimals === null) return '—';
  return formatAmount(formatUnits(BigInt(raw), decimals));
}

// The API's side is fixed relative to currency0 ('buy' = currency0 acquired), same convention
// amount0Raw/amount1Raw already use — but this column always reads "Buy"/"Sell" relative to
// whichever token is currently displayed first (flips with the header's Flip link). When the
// other token is displayed, currency0 being bought means the displayed token was sold, so the
// label must flip too, or the row's own amounts and its Buy/Sell badge would tell contradictory
// stories about the same trade.
function displayedSide(side: string, displayedIsCurrency0: boolean): string {
  if (displayedIsCurrency0) return side;
  if (side === 'buy') return 'sell';
  if (side === 'sell') return 'buy';
  return side;
}

export interface PoolTransactionListProps {
  trades: readonly PoolTrade[];
  displayedSymbol: string | null;
  otherSymbol: string | null;
  displayedDecimals: number | null;
  otherDecimals: number | null;
  displayedIsCurrency0: boolean;
  explorerBase: string | null;
}

export function PoolTransactionList({ trades, displayedSymbol, otherSymbol, displayedDecimals, otherDecimals, displayedIsCurrency0, explorerBase }: PoolTransactionListProps) {
  const now = useNow();
  return (
    <Table aria-label="Transactions" className="border-separate border-spacing-y-2">
      <TableHeader>
        <TableRow className="h-10 border-0 bg-card/80 backdrop-blur-md [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
          <TableHead className="pl-4">Time</TableHead>
          <TableHead >Type</TableHead>
          <TableHead className="text-right">USD</TableHead>
          <TableHead className="text-right">{displaySymbol(displayedSymbol)}</TableHead>
          <TableHead className="text-right">{displaySymbol(otherSymbol)}</TableHead>
          <TableHead className="text-right">Wallet</TableHead>
          <TableHead className="text-right">Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const displayedRaw = displayedIsCurrency0 ? trade.amount0Raw : trade.amount1Raw;
          const otherRaw = displayedIsCurrency0 ? trade.amount1Raw : trade.amount0Raw;
          const side = displayedSide(trade.side, displayedIsCurrency0);
          return (
            <TableRow key={`${trade.blockNumber}-${trade.txHash}-${trade.logIndex}`} className="border-0 hover:bg-transparent">
              <TableCell className="pl-4 text-base text-foreground" title={new Date(trade.timestamp * 1000).toLocaleString('en-US')}>
                <RollingText text={formatRelativeTime(trade.timestamp, now)} />
              </TableCell>
              <TableCell className="text-base">
                <span className={cn(side === 'buy' && 'text-success', side === 'sell' && 'text-destructive')}>
                  {side === 'buy' || side === 'sell' ? `${formatSide(side)} ${displaySymbol(displayedSymbol)}` : formatSide(side)}
                </span>
              </TableCell>
              <TableCell
                className="text-right text-base"
                title={trade.usdValueStatus === 'priced' ? 'Converted at the historical quote price near this trade\'s own execution time, not the current price' : undefined}
              >
                {trade.usdValueStatus === 'pending' ? 'Calculating…' : trade.usdValue === null ? '—' : `$${formatAmount(trade.usdValue, 2)}`}
              </TableCell>
              <TableCell className="text-right text-base">{formatRawAmount(displayedRaw, displayedDecimals)}</TableCell>
              <TableCell className="text-right text-base">{formatRawAmount(otherRaw, otherDecimals)} {displaySymbol(otherSymbol)}</TableCell>
              <TableCell className="text-right text-base">
                {explorerBase ? (
                  <a href={`${explorerBase}/address/${trade.traderAddress}`} target="_blank" rel="noreferrer noopener">
                    <span className="cursor-pointer">{shortAddress(trade.traderAddress)}</span>
                  </a>
                ) : <span className="cursor-pointer">{shortAddress(trade.traderAddress)}</span>}
              </TableCell>
              <TableCell className="text-right text-base">
                {explorerBase ? (
                  <a className="cursor-pointer" href={`${explorerBase}/tx/${trade.txHash}`} target="_blank" rel="noreferrer noopener">
                    {shortAddress(trade.txHash)}
                  </a>
                ) : <span className="cursor-pointer">{shortAddress(trade.txHash)}</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
