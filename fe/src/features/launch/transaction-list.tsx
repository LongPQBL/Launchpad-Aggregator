import { displaySymbol, formatActivityKind, formatAmount, formatSide } from '@/api/format';
import type { OfficialVenue, Transaction } from '@/api/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TokenLogo } from '@/features/launches/token-logo';
import { cn } from '@/lib/utils';

export interface TransactionListProps {
  transactions: readonly Transaction[];
  venues: readonly OfficialVenue[];
  tokenSymbol: string | null;
  quoteAsset: { address: string; symbol: string | null };
  explorerBase?: string;
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

export function TransactionList({ transactions, tokenSymbol, quoteAsset, explorerBase }: TransactionListProps) {
  return (
    <Table aria-label="Transactions">
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">{displaySymbol(tokenSymbol)}</TableHead>
          <TableHead className="text-right">For</TableHead>
          <TableHead className="text-right">USD</TableHead>
          <TableHead>Wallet</TableHead>
          <TableHead>Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((row) => {
          const activityLabel = row.source === 'official' ? formatActivityKind(row.activityKind ?? '') : null;
          return (
            <TableRow key={`${row.blockNumber}-${row.txHash}-${row.logIndex}`}>
              <TableCell className="text-muted-foreground">{new Date(row.timestamp * 1000).toLocaleString('en-US')}</TableCell>
              <TableCell>
                <span className={cn('font-medium', !activityLabel && row.side === 'buy' && 'text-success', !activityLabel && row.side === 'sell' && 'text-destructive')}>
                  {activityLabel ?? formatSide(row.side)}
                </span>
                {row.source === 'pool' && <span className="ml-1 text-xs text-muted-foreground">(pool)</span>}
              </TableCell>
              <TableCell className="text-right font-mono">{formatAmount(row.tokenAmount)}</TableCell>
              <TableCell className="text-right font-mono">
                <span className="inline-flex items-center justify-end gap-1">
                  {formatAmount(row.quoteAmount)} {quoteLabel(row, quoteAsset)}
                  <TokenLogo logoUri={null} symbol={quoteLabel(row, quoteAsset)} />
                </span>
              </TableCell>
              <TableCell
                className="text-right font-mono"
                title={row.usdValueStatus === 'priced' ? 'Converted at the historical quote price near this trade\'s own execution time, not the current price' : undefined}
              >
                {row.usdValueStatus === 'pending' ? 'Calculating…' : formatAmount(row.usdValue)}
              </TableCell>
              <TableCell>
                {explorerBase ? (
                  <a href={`${explorerBase}/address/${row.traderAddress}`} target="_blank" rel="noreferrer noopener">
                    {shortAddress(row.traderAddress)}
                  </a>
                ) : shortAddress(row.traderAddress)}
              </TableCell>
              <TableCell>
                {explorerBase ? (
                  <a href={`${explorerBase}/tx/${row.txHash}`} target="_blank" rel="noreferrer noopener">
                    Tx
                  </a>
                ) : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
