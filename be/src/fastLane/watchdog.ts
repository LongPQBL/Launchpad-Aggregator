/** The chain emits about 30 trade logs a second, so a WebSocket that is silent this long has lost its subscription. */
export const SOCKET_WARN_AFTER_SECONDS = 120;
/** After this much silence the process exits so its supervisor restarts it with a fresh socket. */
export const SOCKET_EXIT_AFTER_SECONDS = 600;

export type WatchdogVerdict = 'ok' | 'warn' | 'exit';

export function socketWatchdogVerdict(silentSeconds: number,
  limits: { warnAfter?: number; exitAfter?: number } = {}): WatchdogVerdict {
  if (silentSeconds >= (limits.exitAfter ?? SOCKET_EXIT_AFTER_SECONDS)) return 'exit';
  if (silentSeconds >= (limits.warnAfter ?? SOCKET_WARN_AFTER_SECONDS)) return 'warn';
  return 'ok';
}
