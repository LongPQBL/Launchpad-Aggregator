'use client';

import { useEffect, useState } from 'react';

export interface TradeSettings {
  slippageBps: number | 'auto';
  deadlineMinutes: number;
  // User opt-in for attempting EIP-5792 batching with a wallet that only reports atomic.status
  // 'ready', not 'supported' — see use-can-batch-calls.ts for why this is safe, not just a risk
  // tradeoff. Off by default: a 'ready' wallet keeps today's two-step flow until the user opts in.
  oneClickTradeOptIn: boolean;
}

const DEFAULT_SETTINGS: TradeSettings = { slippageBps: 'auto', deadlineMinutes: 30, oneClickTradeOptIn: false };
const STORAGE_KEY = 'trade-settings';

// A steep bonding curve moves price heavily on a single buy (competitor research on pump.fun
// found 10-15% common on thin curves — see the trading design spec's "UI flow" section); a
// graduated pool behaves like an ordinary Uniswap pool, where a much tighter default is normal.
export function resolveAutoSlippageBps(venueKind: 'curve' | 'pool'): number {
  return venueKind === 'curve' ? 1200 : 50;
}

const MAX_SLIPPAGE_BPS = 5000;
const MAX_DEADLINE_MINUTES = 1440;

// localStorage is writable by anything running on this origin and survives across sessions, so a stored value is
// untrusted input: an out-of-range slippage (10000 bps = no minimum output) or deadline would reach the swap as-is.
export function sanitizeTradeSettings(value: unknown): TradeSettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const slippage = raw.slippageBps;
  const deadline = raw.deadlineMinutes;
  return {
    slippageBps: typeof slippage === 'number' && Number.isFinite(slippage) && slippage >= 1 && slippage <= MAX_SLIPPAGE_BPS ? slippage : 'auto',
    deadlineMinutes: typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0 && deadline <= MAX_DEADLINE_MINUTES ? deadline : DEFAULT_SETTINGS.deadlineMinutes,
    oneClickTradeOptIn: raw.oneClickTradeOptIn === true,
  };
}

export function useTradeSettings(): { settings: TradeSettings; update: (next: TradeSettings) => void } {
  const [settings, setSettings] = useState<TradeSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- same SSR-safe localStorage-sync pattern as theme-toggle.tsx
      setSettings(sanitizeTradeSettings(JSON.parse(stored)));
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
