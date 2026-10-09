import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { GlobalTransactionList } from '@/features/transactions/global-transaction-list';
import { ROADMAP_CHAIN_IDS } from '@/api/chains';
import { getAllTransactions, getSources, type GlobalTransactionPage } from '@/api/client';
import { chainResourceKey } from '@/hooks/resource-keys';

interface TransactionsPageProps { searchParams: Promise<Record<string, string | string[] | undefined>> }

function parseChainIds(value: string | string[] | undefined): number[] {
  const raw = (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((item) => item.split(','));
  return [...new Set(raw.map((item) => Number(item.trim())).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const selectedChainIds = parseChainIds((await searchParams).chainId);
  let page: GlobalTransactionPage | null = null;
  let indexedChainIds: number[] = [];
  try {
    const [transactions, sources] = await Promise.all([
      getAllTransactions({ chainId: selectedChainIds.length > 0 ? selectedChainIds : undefined }),
      getSources().catch(() => ({ items: [] })),
    ]);
    page = transactions;
    indexedChainIds = [...new Set(sources.items.map((source) => source.chainId))];
  } catch { /* shows the error state below */ }

  // Same options as the launches page's chain filter: the roadmap chains plus any indexed or already-selected one.
  const chainIds = [...new Set([...ROADMAP_CHAIN_IDS, ...indexedChainIds, ...selectedChainIds])];

  return (
    <>
      {page && <LiveRefreshIndicator resourceKeys={indexedChainIds.map(chainResourceKey)} />}
      <div className="space-y-4">
        {page
          ? <GlobalTransactionList heading="Transactions" transactions={page.items} nextCursor={page.nextCursor} chainIds={chainIds} selectedChainIds={selectedChainIds} />
          : <div role="alert"><h1 className="text-2xl font-semibold">Transactions</h1><p>Could not load transactions from the server. Please try again.</p><a href="/transactions">Retry</a></div>}
      </div>
    </>
  );
}
