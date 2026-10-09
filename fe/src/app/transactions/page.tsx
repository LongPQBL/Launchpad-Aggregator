import { AppShell } from '@/components/app-shell';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { GlobalTransactionList } from '@/features/transactions/global-transaction-list';
import { chainExplorerBase } from '@/api/chains';
import { getAllTransactions, type GlobalTransactionPage } from '@/api/client';
import { chainResourceKey } from '@/hooks/resource-keys';

// Robinhood Chain is the only indexed chain so far; an explorer link per row would otherwise need its own chain's base.
const EXPLORER_CHAIN_ID = 4663;

export default async function TransactionsPage() {
  let page: GlobalTransactionPage | null = null;
  try { page = await getAllTransactions(); } catch { /* shows the error state below */ }

  return (
    <AppShell>
      {page && <LiveRefreshIndicator resourceKeys={[chainResourceKey(EXPLORER_CHAIN_ID)]} />}
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted-foreground">Latest official trades across all indexed launches.</p>
        </div>
        {page
          ? <GlobalTransactionList transactions={page.items} nextCursor={page.nextCursor} explorerBase={chainExplorerBase(EXPLORER_CHAIN_ID)} />
          : <div role="alert"><p>Could not load transactions from the server. Please try again.</p><a href="/transactions">Retry</a></div>}
      </div>
    </AppShell>
  );
}
