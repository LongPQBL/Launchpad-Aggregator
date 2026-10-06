'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TradeSettings } from './use-trade-settings';

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
        ⚙
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-border bg-card p-3 shadow-lg text-sm">
          <div className="flex items-center justify-between gap-2">
            <span>Max slippage</span>
            <Button type="button" size="sm" variant={settings.slippageBps === 'auto' ? 'default' : 'outline'}
              onClick={() => onChange({ ...settings, slippageBps: 'auto' })}>
              Auto
            </Button>
          </div>
          <label className="mt-2 flex items-center justify-between gap-2">
            <span>Custom slippage %</span>
            <Input
              aria-label="Custom slippage"
              type="number"
              step="0.1"
              value={settings.slippageBps === 'auto' ? '' : (settings.slippageBps / 100).toString()}
              onChange={(event) => {
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent) || percent <= 0) return;
                onChange({ ...settings, slippageBps: Math.round(percent * 100) });
              }}
              className="w-20"
            />
          </label>
          <label className="mt-2 flex items-center justify-between gap-2">
            <span>Swap deadline (minutes)</span>
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
          <p className="mt-2 text-xs text-muted-foreground">
            {venueKind === 'curve' ? 'Curve-phase trades tolerate more slippage by default — price moves fast on a thin curve.' : null}
          </p>
        </div>
      )}
    </div>
  );
}
