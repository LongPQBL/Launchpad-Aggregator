import type { ApiEventBus, ApiEventType } from './events.js';

const SAMPLES = 200;
const TYPES: readonly ApiEventType[] = ['launch.changed', 'trade.created', 'coverage.changed', 'pool.changed'];

export interface LagStats { samples: number; p50Seconds: number | null; p90Seconds: number | null; maxSeconds: number | null }
export interface EventMetricsSnapshot {
  since: string;
  events: Record<string, { total: number; lastAt: string | null; lag: LagStats; lagByVia: { fast: LagStats; envio: LagStats } }>;
}

function lagStats(samples: readonly number[]): LagStats {
  if (samples.length === 0) return { samples: 0, p50Seconds: null, p90Seconds: null, maxSeconds: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return { samples: sorted.length, p50Seconds: round(percentile(sorted, 0.5)), p90Seconds: round(percentile(sorted, 0.9)), maxSeconds: round(sorted.at(-1)!) };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/**
 * Counts the events this API process hears and, for the ones that carry the time of the block that caused them, how late it hears:
 * block timestamp -> the moment the event reaches the API's bus (the chain -> Envio -> sync -> Postgres part of the pipeline). The last
 * 200 samples per type are kept, so the numbers follow the pipeline as it speeds up or slows down.
 */
export function createEventMetrics(events: ApiEventBus, now: () => number = Date.now): { snapshot: () => EventMetricsSnapshot } {
  const startedAt = now();
  const state = new Map<ApiEventType, { total: number; lastAt: number | null; lags: number[]; lagsByVia: { fast: number[]; envio: number[] } }>(
    TYPES.map((type) => [type, { total: 0, lastAt: null, lags: [], lagsByVia: { fast: [], envio: [] } }]));
  events.subscribe((event) => {
    const entry = state.get(event.type);
    if (!entry) return;
    entry.total += 1;
    entry.lastAt = now();
    if (event.blockTimestamp !== undefined) {
      // A block timestamp a little ahead of this clock is clock skew, not a negative delay.
      const delay = Math.max(0, now() / 1000 - event.blockTimestamp);
      entry.lags.push(delay);
      if (entry.lags.length > SAMPLES) entry.lags.shift();
      const lane = entry.lagsByVia[event.via ?? 'envio'];
      lane.push(delay);
      if (lane.length > SAMPLES) lane.shift();
    }
  });
  return {
    snapshot() {
      const out: EventMetricsSnapshot['events'] = {};
      for (const [type, entry] of state) {
        out[type] = {
          total: entry.total,
          lastAt: entry.lastAt === null ? null : new Date(entry.lastAt).toISOString(),
          lag: lagStats(entry.lags),
          lagByVia: { fast: lagStats(entry.lagsByVia.fast), envio: lagStats(entry.lagsByVia.envio) },
        };
      }
      return { since: new Date(startedAt).toISOString(), events: out };
    },
  };
}
