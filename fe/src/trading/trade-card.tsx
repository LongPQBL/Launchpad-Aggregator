import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { sanitizeAmountInput } from './amount';
import { RollingText } from '@/components/percent-change';
import type { ImpactLevel } from './price-impact';

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
  // How far the trade moves the price, from price-impact.ts; null/omitted hides the row. A 'severe' level also asks the
  // user to tick a box (ack) before the panel lets the trade through.
  // A token in the pair takes a fee or refuses transfers, so the amount received will differ from the quote; null hides it.
  tokenWarning?: string | null;
  priceImpact?: { text: string; level: ImpactLevel; acknowledged: boolean; onAcknowledge: (value: boolean) => void } | null;
  footer?: ReactNode;
}

// Presentational only: two stacked cards (Sell on top, Buy below) with the flip arrow overlapping
// the seam, as on Uniswap. No trade logic lives here — panels own state, quotes and submission.
export function TradeCard({ sell, buy, onFlip, minReceived = null, priceImpact = null, tokenWarning = null, footer }: TradeCardProps) {
  const [activeSide, setActiveSide] = useState<'sell' | 'buy'>('sell');
  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex flex-col gap-1.5">
        <Side label="Sell" side={sell} active={activeSide === 'sell'} onFocus={() => setActiveSide('sell')} />
        <Side label="Buy" side={buy} active={activeSide === 'buy'} onFocus={() => setActiveSide('buy')} />
        <Button type="button" variant="outline" size="sm" aria-label="Flip swap direction"
          className="absolute top-1/2 left-1/2 z-10 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 border-background bg-muted p-0 text-base hover:bg-[#343842]"
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
      {tokenWarning !== null && (
        <p role="status" data-testid="token-fee-warning" className="px-1 text-sm text-amber-500">{tokenWarning}</p>
      )}
      {priceImpact !== null && (
        <div className="flex flex-col gap-2 px-1 text-base">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Price impact</span>
            <span data-testid="price-impact" data-level={priceImpact.level}
              className={cn(priceImpact.level === 'warn' && 'text-amber-500', priceImpact.level === 'severe' && 'text-destructive')}>
              {priceImpact.text}
            </span>
          </div>
          {priceImpact.level !== 'ok' && (
            <p role="alert" className={cn('text-sm', priceImpact.level === 'severe' ? 'text-destructive' : 'text-amber-500')}>
              This trade moves the price by {priceImpact.text}, so you receive noticeably less than the current price implies.
            </p>
          )}
          {priceImpact.level === 'severe' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={priceImpact.acknowledged} onChange={(event) => priceImpact.onAcknowledge(event.target.checked)} />
              I understand I will lose about {priceImpact.text} to price impact
            </label>
          )}
        </div>
      )}
      {footer}
    </div>
  );
}

function Side({ label, side, active, onFocus }: { label: string; side: TradeCardSide; active: boolean; onFocus: () => void }) {
  return (
    <div className="relative rounded-3xl p-4">
      <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 z-0 rounded-3xl border',
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
