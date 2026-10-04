import { formatActivityKind, formatQuote, formatSide, formatUsd, formatVenueKind } from '@/api/format';
import type { OfficialVenue, Trade } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface TradeListProps {
  trades: readonly Trade[];
  venues: readonly OfficialVenue[];
  quoteSymbol: string;
  explorerBase?: string;
}

export function TradeList({ trades, venues, quoteSymbol, explorerBase }: TradeListProps) {
  const venueById = new Map(venues.map((v) => [v.id, v]));

  return (
    <Table aria-label="Official trades">
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Venue</TableHead>
          <TableHead className="text-right">Token amount</TableHead>
          <TableHead className="text-right">{quoteSymbol} amount</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">USD</TableHead>
          <TableHead>Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const venue = venueById.get(trade.venueId);
          const activityLabel = formatActivityKind(trade.activityKind);
          return (
            <TableRow key={`${trade.blockNumber}-${trade.txHash}-${trade.logIndex}`}>
              <TableCell className="text-muted-foreground">{new Date(trade.timestamp * 1000).toLocaleString('en-US')}</TableCell>
              <TableCell
                className={cn(
                  'font-medium',
                  !activityLabel && trade.side === 'buy' && 'text-success',
                  !activityLabel && trade.side === 'sell' && 'text-destructive',
                )}
              >
                {activityLabel ?? formatSide(trade.side)}
              </TableCell>
              <TableCell>{venue ? formatVenueKind(venue.kind) : trade.venueId}</TableCell>
              <TableCell className="text-right font-mono">{trade.tokenAmount}</TableCell>
              <TableCell className="text-right font-mono">
                {trade.quoteAmount} {quoteSymbol}
              </TableCell>
              <TableCell className="text-right font-mono">{formatQuote(trade.priceQuote, quoteSymbol)}</TableCell>
              <TableCell
                className="text-right font-mono"
                title={trade.usdValueStatus === 'priced' ? 'Converted at the historical quote price near this trade\'s own execution time, not the current price' : undefined}
              >
                {trade.usdValueStatus === 'pending' ? 'Calculating…' : formatUsd(trade.usdValue)}
              </TableCell>
              <TableCell>
                {explorerBase ? (
                  <a href={`${explorerBase}/tx/${trade.txHash}`} target="_blank" rel="noreferrer noopener">
                    Tx
                  </a>
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
