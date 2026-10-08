import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function SwapPanelPreview({ sellSymbol, buySymbol }: { sellSymbol: string; buySymbol: string }) {
  return (
    <div className="flex flex-col gap-3" aria-label="Swap panel preview">
      <div className="flex items-center justify-between">
        <span className="text-sm">Sell</span>
        <span className="text-xs text-muted-foreground">Preview only · fake data</span>
      </div>
      <div className="flex items-center gap-2 py-2">
        <Input aria-label="Preview sell amount" readOnly value="1,000" className="flex-1 border-0 bg-transparent shadow-none" />
        <span className="px-2 py-2 text-sm font-medium">{sellSymbol}</span>
      </div>
      <div className="flex justify-center text-muted-foreground" aria-hidden="true">↓</div>
      <div className="flex items-center gap-2 py-2">
        <Input aria-label="Preview receive amount" readOnly value="0.42" className="flex-1 border-0 bg-transparent shadow-none" />
        <span className="px-2 py-2 text-sm font-medium">{buySymbol}</span>
      </div>
      <p className="text-xs text-muted-foreground">Estimated amount · sample quote</p>
      <Button type="button" disabled>Preview only</Button>
    </div>
  );
}
