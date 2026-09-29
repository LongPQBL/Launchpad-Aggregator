import { formatActivityKind, formatQuote, formatSide, formatVenueKind } from '@/api/format';
import type { OfficialVenue, Trade } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface TradeListProps {
  trades: readonly Trade[];
  venues: readonly OfficialVenue[];
  quoteSymbol: string;
  explorerBase?: string;
}

export function TradeList({ trades, venues, quoteSymbol, explorerBase }: TradeListProps) {
  const venueById = new Map(venues.map((v) => [v.id, v]));

  return (
    <Table aria-label="Giao dịch chính thức">
      <TableHeader>
        <TableRow>
          <TableHead>Thời gian</TableHead>
          <TableHead>Loại</TableHead>
          <TableHead>Nơi giao dịch</TableHead>
          <TableHead>Lượng token</TableHead>
          <TableHead>Lượng {quoteSymbol}</TableHead>
          <TableHead>Giá</TableHead>
          <TableHead>Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const venue = venueById.get(trade.venueId);
          const activityLabel = formatActivityKind(trade.activityKind);
          return (
            <TableRow key={`${trade.blockNumber}-${trade.txHash}-${trade.logIndex}`}>
              <TableCell>{new Date(trade.timestamp * 1000).toLocaleString('vi-VN')}</TableCell>
              <TableCell>{activityLabel ?? formatSide(trade.side)}</TableCell>
              <TableCell>{venue ? formatVenueKind(venue.kind) : trade.venueId}</TableCell>
              <TableCell>{trade.tokenAmount}</TableCell>
              <TableCell>
                {trade.quoteAmount} {quoteSymbol}
              </TableCell>
              <TableCell>{formatQuote(trade.priceQuote, quoteSymbol)}</TableCell>
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
