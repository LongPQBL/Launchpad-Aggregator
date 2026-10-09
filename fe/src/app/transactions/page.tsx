import { AppShell } from '@/components/app-shell';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { GlobalTransactionList } from '@/features/transactions/global-transaction-list';
import { getAllTransactions, getSources, type GlobalTransactionPage } from '@/api/client';
import { chainResourceKey } from '@/hooks/resource-keys';

export default async function TransactionsPage() {
  let page: GlobalTransactionPage | null = null;
  let chainIds: number[] = [];
  try {
    const [transactions, sources] = await Promise.all([getAllTransactions(), getSources().catch(() => ({ items: [] }))]);
    page = transactions;
    chainIds = [...new Set(sources.items.map((source) => source.chainId))];
  } catch { /* shows the error state below */ }

  return (
    <AppShell>
      {page && <LiveRefreshIndicator resourceKeys={chainIds.map(chainResourceKey)} />}
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted-foreground">Latest trades of all indexed launches, including swaps in other pools that hold them.</p>
        </div>
        {page
          ? <GlobalTransactionList transactions={page.items} nextCursor={page.nextCursor} />
          : <div role="alert"><p>Could not load transactions from the server. Please try again.</p><a href="/transactions">Retry</a></div>}
      </div>
    </AppShell>
  );
}
