'use client';

import { useEffect, useState } from 'react';

export interface TradeSettings {
  slippageBps: number | 'auto';
  deadlineMinutes: number;
}

const DEFAULT_SETTINGS: TradeSettings = { slippageBps: 'auto', deadlineMinutes: 30 };
const STORAGE_KEY = 'trade-settings';

// A steep bonding curve moves price heavily on a single buy (competitor research on pump.fun
// found 10-15% common on thin curves — see the trading design spec's "UI flow" section); a
// graduated pool behaves like an ordinary Uniswap pool, where a much tighter default is normal.
export function resolveAutoSlippageBps(venueKind: 'curve' | 'pool'): number {
  return venueKind === 'curve' ? 1200 : 50;
}

export function useTradeSettings(): { settings: TradeSettings; update: (next: TradeSettings) => void } {
  const [settings, setSettings] = useState<TradeSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- same SSR-safe localStorage-sync pattern as theme-toggle.tsx
      setSettings(JSON.parse(stored) as TradeSettings);
    } catch {
      // Malformed stored value — keep the default rather than crashing.
    }
  }, []);

  function update(next: TradeSettings) {
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  return { settings, update };
}
