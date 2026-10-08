import { Button } from '@/components/ui/button';
import { TradeCard } from './trade-card';

const noop = () => {};
const pill = (symbol: string) => (
  <span className="rounded-full border border-border px-3 py-1.5 text-sm font-medium">{symbol}</span>
);

// Fake data on purpose and labeled as such: shown when a launch has no tradable venue yet, so the
// layout is visible without implying a real quote.
export function SwapPanelPreview({ sellSymbol, buySymbol }: { sellSymbol: string; buySymbol: string }) {
  return (
    <div className="flex flex-col gap-3" aria-label="Swap panel preview">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-muted px-4 py-1.5 text-base font-semibold">Swap</span>
        <span className="text-xs text-muted-foreground">Sample data</span>
      </div>
      <TradeCard
        sell={{ value: '1000', onChange: noop, ariaLabel: 'Preview sell amount', selector: pill(sellSymbol), usdText: null, hint: null }}
        buy={{ value: '0.42', onChange: noop, ariaLabel: 'Preview receive amount', selector: pill(buySymbol), usdText: null, hint: 'Sample quote' }}
        onFlip={noop}
        footer={<Button type="button" disabled>Preview only</Button>}
      />
    </div>
  );
}
