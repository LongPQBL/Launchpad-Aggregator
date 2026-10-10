import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { sanitizeAmountInput } from './amount';
import { RollingText } from '@/components/percent-change';

export interface TradeCardSide {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  selector: ReactNode;
  // null hides the line — never render a placeholder "$0".
  usdText: string | null;
  // Short status under the amount (e.g. "Quote unavailable", "Estimating…"); null shows nothing.
  hint: string | null;
  // Sell-side wallet balance, shown below the token selector once it is known.
  balanceText?: string | null;
  insufficientBalance?: boolean;
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
  const [activeSide, setActiveSide] = useState<'sell' | 'buy'>('sell');
  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex flex-col gap-1.5">
        <Side label="Sell" side={sell} active={activeSide === 'sell'} onFocus={() => setActiveSide('sell')} />
        <Side label="Buy" side={buy} active={activeSide === 'buy'} onFocus={() => setActiveSide('buy')} />
        <Button type="button" variant="outline" size="sm" aria-label="Flip swap direction"
          className="absolute top-1/2 left-1/2 z-10 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 border-background bg-muted p-0 text-base"
          onClick={onFlip}>
          <span aria-hidden="true">↓</span>
        </Button>
      </div>
      {minReceived !== null && (
        <div className="flex items-center justify-between px-1 text-base text-muted-foreground">
          <span>Min received</span>
          <span><RollingText text={minReceived} /></span>
        </div>
      )}
      {footer}
    </div>
  );
}

function Side({ label, side, active, onFocus }: { label: string; side: TradeCardSide; active: boolean; onFocus: () => void }) {
  return (
    <div className="relative isolate rounded-3xl p-4">
      <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 -z-10 rounded-3xl border',
        active ? 'border-[#343842] bg-black' : 'border-[#343842] bg-[#1b1d23]/70')} />
      <div className={cn('relative flex flex-col gap-2', active && 'text-white')}>
        <span className="text-base leading-5 text-muted-foreground">{label}</span>
        <div className="flex items-center justify-between gap-3">
          <Input
            aria-label={side.ariaLabel}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={side.value}
            onChange={(event) => side.onChange(sanitizeAmountInput(event.target.value))}
            onFocus={onFocus}
            aria-invalid={side.insufficientBalance || undefined}
            className={cn('h-11 flex-1 border-0 bg-transparent px-0 text-4xl leading-10 shadow-none focus-visible:ring-0', active && 'text-white',
              side.insufficientBalance && 'text-destructive')}
          />
          <div className="flex shrink-0 flex-col items-end gap-2">
            {side.selector}
            {side.balanceText && <span title={side.balanceText} className={cn('max-w-40 truncate text-right text-sm text-muted-foreground', side.insufficientBalance && 'text-destructive')}>
              <RollingText text={side.balanceText} />
            </span>}
          </div>
        </div>
        <div className="flex min-h-[18px] items-center justify-between text-sm text-muted-foreground">
          <span>{side.usdText === null ? null : <RollingText text={side.usdText} />}</span>
          <span>{side.hint}</span>
        </div>
      </div>
    </div>
  );
}
