'use client';

import { useEffect, useState } from 'react';
import type { SseEventPayload } from './resource-keys';
import { useLiveFirstPage } from './use-live-first-page';

export type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

/** Runs `load` once when mounted (and again when `deps` change) and reports loading / error / ready; an answer for an older run is ignored. */
export function useLoaded<T>(load: () => Promise<T>, deps: readonly unknown[],
  /** Reload quietly (the old answer stays on screen) whenever a matching announcement arrives. */
  live?: { eventName: string | readonly string[]; matches: (payload: SseEventPayload) => boolean; minIntervalMs?: number }): Loaded<T> {
  const [state, setState] = useState<{ deps: readonly unknown[]; value: Loaded<T> }>({ deps, value: { status: 'loading' } });
  useEffect(() => {
    let current = true;
    load().then(
      (data) => { if (current) setState({ deps, value: { status: 'ready', data } }); },
      () => { if (current) setState({ deps, value: { status: 'error' } }); },
    );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is a fresh closure each render; `deps` says when to run again
  }, deps);
  useLiveFirstPage(
    (payload) => live?.matches(payload) ?? false,
    async (isStale) => {
      const data = await load();
      if (!isStale()) setState({ deps, value: { status: 'ready', data } });
    },
    deps,
    live?.eventName,
    live?.minIntervalMs,
  );
  const stale = state.deps.length !== deps.length || state.deps.some((value, index) => value !== deps[index]);
  return stale ? { status: 'loading' } : state.value;
}
