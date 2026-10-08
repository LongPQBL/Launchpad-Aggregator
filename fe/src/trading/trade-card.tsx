import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface TradeCardSide {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  selector: ReactNode;
  // null hides the line — never render a placeholder "$0".
  usdText: string | null;
  // Short status under the amount (e.g. "Quote unavailable", "Estimating…"); null shows nothing.
  hint: string | null;
}

export interface TradeCardProps {
  sell: TradeCardSide;
  buy: TradeCardSide;
  onFlip: () => void;
  // Pre-formatted "least you receive after slippage" text; null/omitted hides the row.
  minReceived?: string | null;
  footer?: ReactNode;
}

// Presentational only: two stacked cards (Sell on top, Buy below) with the flip arrow overlapping
// the seam, as on Uniswap. No trade logic lives here — panels own state, quotes and submission.
export function TradeCard({ sell, buy, onFlip, minReceived = null, footer }: TradeCardProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex flex-col gap-1">
        <Side label="Sell" side={sell} className="bg-card border border-border" />
        <Side label="Buy" side={buy} className="bg-muted" />
        <Button type="button" variant="outline" size="sm" aria-label="Flip swap direction"
          className="absolute top-1/2 left-1/2 z-10 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 border-background bg-muted p-0"
          onClick={onFlip}>
          <span aria-hidden="true">↓</span>
        </Button>
      </div>
      {minReceived !== null && (
        <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
          <span>Min received</span>
          <span>{minReceived}</span>
        </div>
      )}
      {footer}
    </div>
  );
}

function Side({ label, side, className }: { label: string; side: TradeCardSide; className: string }) {
  return (
    <div className={`flex flex-col gap-1 rounded-2xl p-4 ${className}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center justify-between gap-2">
        <Input
          aria-label={side.ariaLabel}
          type="number"
          inputMode="decimal"
          placeholder="0"
          value={side.value}
          onChange={(event) => side.onChange(event.target.value)}
          className="h-12 flex-1 border-0 bg-transparent px-0 text-3xl font-medium shadow-none focus-visible:ring-0"
        />
        {side.selector}
      </div>
      <div className="flex min-h-5 items-center justify-between text-sm text-muted-foreground">
        <span>{side.usdText}</span>
        <span>{side.hint}</span>
      </div>
    </div>
  );
}
