'use client';

import Image from 'next/image';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TradeSettings } from './use-trade-settings';

function InfoTooltip({ label, description }: { label: string; description: string }) {
  const tooltipId = `trade-setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={tooltipId}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/60 text-[10px] font-semibold leading-none text-muted-foreground hover:border-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        i
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        aria-label={label}
        className="invisible absolute bottom-full left-1/2 z-30 mb-2 w-56 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-2 text-xs font-normal leading-relaxed text-foreground opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {description}
      </span>
    </span>
  );
}

function SettingLabel({ label, description }: { label: string; description: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <InfoTooltip label={label} description={description} />
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

  return (
    <div className="relative">
      <Button type="button" variant="ghost" size="sm" aria-label="Trade settings" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Image src="/images/trading/settings.png" alt="" width={48} height={48} unoptimized className="h-5 w-5" />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-border bg-card p-3 shadow-lg text-sm">
          <div className="flex items-center justify-between gap-2">
            <SettingLabel label="Max slippage" description={venueKind === 'curve'
              ? 'The maximum price movement accepted before the trade fails. Auto uses a higher allowance on a fast-moving curve.'
              : 'The maximum price movement accepted before the trade fails. Auto adjusts the allowance for the selected pool.'} />
            <Button type="button" size="sm" variant={settings.slippageBps === 'auto' ? 'default' : 'outline'}
              onClick={() => onChange({ ...settings, slippageBps: 'auto' })}>
              Auto
            </Button>
          </div>
          <label className="mt-2 flex items-center justify-between gap-2">
            <SettingLabel label="Custom slippage %" description="Set the maximum price movement you will accept from the quoted price. The trade fails if the price moves beyond this amount." />
            <Input
              aria-label="Custom slippage"
              type="number"
              step="0.1"
              value={settings.slippageBps === 'auto' ? '' : (settings.slippageBps / 100).toString()}
              onChange={(event) => {
                const percent = Number(event.target.value);
                // Above 50% is rejected outright, not clamped — a user who means to type this is
                // almost certainly making a mistake, and amount.ts's applySlippage separately
                // clamps defensively in case any other caller ever skips this check.
                if (!Number.isFinite(percent) || percent <= 0 || percent > 50) return;
                onChange({ ...settings, slippageBps: Math.round(percent * 100) });
              }}
              className="w-20"
            />
          </label>
          {venueKind === 'pool' && (
            <label className="mt-2 flex items-center justify-between gap-2">
              <SettingLabel label="Swap deadline (minutes)" description="The transaction expires after this many minutes if it has not been confirmed." />
              <Input
                aria-label="Deadline minutes"
                type="number"
                value={settings.deadlineMinutes}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  if (!Number.isFinite(minutes) || minutes <= 0) return;
                  onChange({ ...settings, deadlineMinutes: minutes });
                }}
                className="w-20"
              />
            </label>
          )}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
            <SettingLabel label="1-click trade" description="Allows a compatible wallet to combine approval and trade into one confirmation when supported. Wallet support may vary." />
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
