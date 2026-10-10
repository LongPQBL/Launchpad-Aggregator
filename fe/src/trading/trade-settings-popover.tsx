'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { resolveAutoSlippageBps, type TradeSettings } from './use-trade-settings';

function InfoTooltip({ label, description }: { label: string; description: string }) {
  const tooltipId = `trade-setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={tooltipId}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/60 text-[10px] leading-none text-muted-foreground hover:border-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        i
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        aria-label={label}
        className="invisible absolute bottom-full left-1/2 z-30 mb-2 w-56 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-2 text-xs leading-relaxed text-foreground opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {description}
      </span>
    </span>
  );
}

function SettingLabel({ label, description, tooltipLabel = label }: { label: string; description: string; tooltipLabel?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <InfoTooltip label={tooltipLabel} description={description} />
    </span>
  );
}

export interface TradeSettingsPopoverProps {
  settings: TradeSettings;
  onChange: (next: TradeSettings) => void;
  venueKind: 'curve' | 'pool';
}

export function TradeSettingsPopover({ settings, onChange, venueKind }: TradeSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const isAutoSlippage = settings.slippageBps === 'auto';
  const autoSlippagePercent = resolveAutoSlippageBps(venueKind) / 100;
  const displayedSlippagePercent = settings.slippageBps === 'auto' ? autoSlippagePercent : settings.slippageBps / 100;
  const [slippageDraft, setSlippageDraft] = useState(() => String(displayedSlippagePercent));
  const isEditingSlippage = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (isEditingSlippage.current) return;
    // Sync values loaded from storage or changed outside this input.
    setSlippageDraft(String(displayedSlippagePercent));
  }, [displayedSlippagePercent]);

  return (
    <div ref={containerRef} className="relative">
      <div className={isAutoSlippage ? 'inline-flex items-center' : 'inline-flex items-center rounded-full bg-white/10 pl-3'}>
        {!isAutoSlippage && <span className="text-sm text-white/60">{displayedSlippagePercent}%</span>}
        <Button type="button" variant="ghost" aria-label="Trade settings" aria-expanded={open} onClick={() => setOpen(!open)} className="h-8 w-8 p-1.5">
          <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.7922 15.1778C21.6555 14.5178 20.9589 13.3078 20.9589 12C20.9589 10.6922 21.6555 9.48221 22.7922 8.82221C22.9878 8.69999 23.0611 8.45556 22.9389 8.26L20.8978 4.74C20.8244 4.60555 20.69 4.53224 20.5556 4.53224C20.4822 4.53224 20.4089 4.55667 20.3478 4.59334C19.7855 4.91111 19.15 5.08222 18.5144 5.08222C17.8667 5.08222 17.2311 4.9111 16.6567 4.5811C15.52 3.9211 14.8233 2.72333 14.8233 1.41555C14.8233 1.18333 14.64 1 14.42 1H9.57999C9.35999 1 9.17667 1.18333 9.17667 1.41555C9.17667 2.72333 8.48 3.9211 7.34334 4.5811C6.76889 4.9111 6.13335 5.08222 5.48557 5.08222C4.85002 5.08222 4.21446 4.91111 3.65224 4.59334C3.45668 4.47111 3.21222 4.54444 3.10222 4.74L1.0489 8.26C1.01223 8.32111 1 8.39445 1 8.45556C1 8.60223 1.07335 8.73666 1.20779 8.82221C2.34446 9.48221 3.04113 10.68 3.04113 11.9878C3.04113 13.3078 2.34444 14.5178 1.21999 15.1778H1.20779C1.01224 15.3 0.938874 15.5444 1.0611 15.74L3.10222 19.26C3.17556 19.3944 3.31 19.4678 3.44444 19.4678C3.51778 19.4678 3.59113 19.4433 3.65224 19.4067C4.80113 18.7589 6.20667 18.7589 7.34334 19.4189C8.46778 20.0789 9.16444 21.2767 9.16444 22.5844C9.16444 22.8167 9.34776 23 9.57999 23H14.42C14.64 23 14.8233 22.8167 14.8233 22.5844C14.8233 21.2767 15.52 20.0789 16.6567 19.4189C17.2311 19.0889 17.8667 18.9178 18.5144 18.9178C19.15 18.9178 19.7855 19.0889 20.3478 19.4067C20.5433 19.5289 20.7878 19.4556 20.8978 19.26L22.9511 15.74C22.9878 15.6789 23 15.6055 23 15.5444C23 15.3978 22.9267 15.2633 22.7922 15.1778ZM12 15.6667C9.97111 15.6667 8.33333 14.0289 8.33333 12C8.33333 9.97111 9.97111 8.33333 12 8.33333C14.0289 8.33333 15.6667 9.97111 15.6667 12C15.6667 14.0289 14.0289 15.6667 12 15.6667Z" fill="currentColor" />
          </svg>
        </Button>
      </div>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-3xl border border-border bg-card p-4 text-base shadow-lg space-y-1">
          <div className="flex min-h-12 items-center justify-between gap-2">
            <SettingLabel label="Max slippage" description={venueKind === 'curve'
              ? 'The maximum price movement accepted before the trade fails. Auto uses a higher allowance on a fast-moving curve.'
              : 'The maximum price movement accepted before the trade fails. Auto adjusts the allowance for the selected pool.'} />
            <div className="flex items-center gap-1 rounded-full border border-white/15 p-1">
            <Button type="button" size="sm"
              className={isAutoSlippage ? 'rounded-full bg-brand/20 text-brand hover:bg-brand/25 hover:text-brand' : 'rounded-full bg-white/10 text-white/50 hover:bg-white/10 hover:text-white/60'}
              onClick={() => {
                isEditingSlippage.current = false;
                setSlippageDraft(String(autoSlippagePercent));
                onChange({ ...settings, slippageBps: 'auto' });
              }}>
              Auto
            </Button>
            <Input
              aria-label="Custom slippage"
              type="number"
              min="0.1"
              max="50"
              step="0.1"
              value={slippageDraft}
              onFocus={() => { isEditingSlippage.current = true; }}
              onChange={(event) => {
                const rawValue = event.target.value;
                setSlippageDraft(rawValue);
                const percent = Number(rawValue);
                if (!Number.isFinite(percent) || percent <= 0 || percent > 50) return;
                onChange({ ...settings, slippageBps: Math.round(percent * 100) });
              }}
              onBlur={() => {
                isEditingSlippage.current = false;
                setSlippageDraft(String(displayedSlippagePercent));
              }}
              style={{ width: `${Math.max(3, slippageDraft.length + 1)}ch` }}
              className="h-8 rounded-full border-0 px-1 text-right shadow-none focus-visible:border-0 focus-visible:ring-0"
            />
            <span className="pr-1 text-sm text-muted-foreground">%</span>
            </div>
          </div>
          {venueKind === 'pool' && (
            <label className="flex min-h-12 items-center justify-between gap-2">
            <SettingLabel label="Swap deadline" tooltipLabel="Swap deadline (minutes)" description="The transaction expires after this many minutes if it has not been confirmed." />
              <div className="flex items-center rounded-full border border-white/15 px-3 py-1">
                <Input
                  aria-label="Deadline minutes"
                  type="number"
                  value={settings.deadlineMinutes}
                  onChange={(event) => {
                    const minutes = Number(event.target.value);
                    if (!Number.isFinite(minutes) || minutes <= 0) return;
                    onChange({ ...settings, deadlineMinutes: minutes });
                  }}
                  className="h-6 w-8 border-0 px-0 text-right text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
                />
                <span className="text-sm text-muted-foreground">minutes</span>
              </div>
            </label>
          )}
          <div className="flex min-h-12 items-center justify-between gap-2">
            <SettingLabel label="Trade options" tooltipLabel="1-click trade" description="Allows a compatible wallet to combine approval and trade into one confirmation when supported. Wallet support may vary." />
            <Button type="button" size="sm" aria-label="1-click trade" variant={settings.oneClickTradeOptIn ? 'default' : 'outline'}
              onClick={() => onChange({ ...settings, oneClickTradeOptIn: !settings.oneClickTradeOptIn })}>
              {settings.oneClickTradeOptIn ? 'On' : 'Off'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
