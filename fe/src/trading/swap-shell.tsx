import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { TradeSettingsPopover } from './trade-settings-popover';
import type { TradeSettings } from './use-trade-settings';

export interface SwapShellProps {
  // Names the venue the trade really executes on ("Bonding curve", "Uniswap V3 pool", …) —
  // fees and slippage differ by venue, so it is never hidden.
  venueLabel: string;
  settings: TradeSettings;
  onSettingsChange: (settings: TradeSettings) => void;
  venueKind: 'curve' | 'pool';
  children: ReactNode;
}

export function SwapShell({ venueLabel, settings, onSettingsChange, venueKind, children }: SwapShellProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-4 py-1.5 text-base font-semibold">Swap</span>
          <Badge variant="outline">{venueLabel}</Badge>
        </div>
        <TradeSettingsPopover settings={settings} onChange={onSettingsChange} venueKind={venueKind} />
      </div>
      {children}
    </div>
  );
}
