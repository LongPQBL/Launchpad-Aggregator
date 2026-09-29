import { formatActivityKind, formatQuote, formatSide, formatVenueKind } from '@/api/format';
import type { OfficialVenue, Trade } from '@/api/client';

export interface TradeListProps {
  trades: readonly Trade[];
  venues: readonly OfficialVenue[];
  quoteSymbol: string;
  explorerBase?: string;
}

export function TradeList({ trades, venues, quoteSymbol, explorerBase }: TradeListProps) {
  const venueById = new Map(venues.map((v) => [v.id, v]));

  return (
    <table aria-label="Giao dịch chính thức">
      <thead>
        <tr>
          <th>Thời gian</th>
          <th>Loại</th>
          <th>Nơi giao dịch</th>
          <th>Lượng token</th>
          <th>Lượng {quoteSymbol}</th>
          <th>Giá</th>
          <th>Explorer</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((trade) => {
          const venue = venueById.get(trade.venueId);
          const activityLabel = formatActivityKind(trade.activityKind);
          return (
            <tr key={`${trade.blockNumber}-${trade.txHash}-${trade.logIndex}`}>
              <td>{new Date(trade.timestamp * 1000).toLocaleString('vi-VN')}</td>
              <td>{activityLabel ?? formatSide(trade.side)}</td>
              <td>{venue ? formatVenueKind(venue.kind) : trade.venueId}</td>
              <td>{trade.tokenAmount}</td>
              <td>
                {trade.quoteAmount} {quoteSymbol}
              </td>
              <td>{formatQuote(trade.priceQuote, quoteSymbol)}</td>
              <td>
                {explorerBase ? (
                  <a href={`${explorerBase}/tx/${trade.txHash}`} target="_blank" rel="noreferrer noopener">
                    Tx
                  </a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
