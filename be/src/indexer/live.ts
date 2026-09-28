export type StopFn = () => void;

export interface LiveDeps {
  confirmationDepth: bigint;
  pollIntervalMs: number;
  getHttpHead(): Promise<bigint>;
  reconcileHead?(safeHead: bigint): Promise<void>;
  scanToSafeHead(safeHead: bigint): Promise<void>;
  recordSafeHead?(safeHead: bigint): Promise<void>;
  schedulePoll(callback: () => Promise<void>, intervalMs: number): StopFn;
  watchHeads?(callback: () => Promise<void>, onError: (error: unknown) => void): StopFn;
  onError?(error: unknown): void;
}

export async function startLiveIndexer(deps: LiveDeps): Promise<StopFn> {
  if (deps.confirmationDepth < 0n || deps.pollIntervalMs < 1) throw new Error('Invalid live indexer configuration');
  let stopped = false;
  let lastSafeHead: bigint | null = null;
  let inFlight: Promise<void> | null = null;

  async function sync(): Promise<void> {
    if (stopped) return;
    if (inFlight) await inFlight;
    if (stopped) return;
    const work = (async () => {
      const head = await deps.getHttpHead();
      const safeHead = head > deps.confirmationDepth ? head - deps.confirmationDepth : 0n;
      await deps.reconcileHead?.(safeHead);
      if (lastSafeHead !== null && safeHead <= lastSafeHead) return;
      await deps.scanToSafeHead(safeHead);
      await deps.recordSafeHead?.(safeHead);
      lastSafeHead = safeHead;
    })();
    inFlight = work;
    try {
      await work;
    } finally {
      if (inFlight === work) inFlight = null;
    }
  }

  await sync();
  const stopPolling = deps.schedulePoll(async () => {
    try { await sync(); } catch (error) { deps.onError?.(error); }
  }, deps.pollIntervalMs);
  let stopWatching: StopFn | undefined;
  try {
    stopWatching = deps.watchHeads?.(async () => {
      try { await sync(); } catch (error) { deps.onError?.(error); }
    }, (error) => deps.onError?.(error));
  } catch (error) {
    deps.onError?.(error);
  }
  return () => {
    stopped = true;
    stopWatching?.();
    stopPolling();
  };
}
