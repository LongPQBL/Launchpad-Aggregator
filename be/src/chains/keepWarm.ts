/**
 * The RPC provider closes an idle HTTP connection after a few seconds, so a process that calls it only now and then pays a new TCP/TLS
 * handshake on each call (measured: 800-1,200 ms instead of ~250 ms when calls were 4-8 s apart; none when they were <= 2 s apart). A
 * cheap `eth_blockNumber` every second or so keeps the connection open for the calls that matter (a launch's live recompute, an API read).
 */
export function startRpcKeepWarm(client: { getBlockNumber(options?: { cacheTime?: number }): Promise<unknown> }, env: NodeJS.ProcessEnv = process.env): () => void {
  const raw = env.RPC_KEEP_WARM_MS;
  const intervalMs = raw === undefined || raw === '' ? 1_500 : Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  const timer = setInterval(() => { void client.getBlockNumber({ cacheTime: 0 }).catch(() => { /* only a warm-up; the real calls report their own errors */ }); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
