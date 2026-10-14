/** RPC URLs embed the provider key, and viem puts them in error messages: never print one. */
export function redactUrls(text: string): string {
  return text.replace(/(?:wss?|https?):\/\/[^\s"'`)>]*/gi, '[redacted-url]');
}

export function redactError(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}

/** One console argument as a redacted string: an Error becomes its message (no stack), any other object its JSON. */
export function redactArgument(value: unknown): string {
  if (typeof value === 'string') return redactUrls(value);
  if (value instanceof Error) return redactError(value);
  if (value === null || typeof value !== 'object') return redactUrls(String(value));
  try {
    return redactUrls(JSON.stringify(value, (_key, inner) => {
      if (typeof inner === 'bigint') return inner.toString();
      if (inner instanceof Error) return redactError(inner);
      return inner;
    }) ?? String(value));
  } catch {
    return '[unserializable]'; // a circular structure: printing nothing is safer than printing it raw
  }
}

type ConsoleMethod = 'log' | 'warn' | 'error';
type ConsoleLike = Record<ConsoleMethod, (...args: unknown[]) => void>;

/**
 * Routes every argument of console.log/warn/error through redaction. Libraries print errors with the RPC URL in them on their own (viem's
 * socket reconnect does `setup().catch(console.error)`), so wrapping our own log calls is not enough. Returns a function that undoes it.
 */
export function installConsoleRedaction(target: ConsoleLike): () => void {
  const originals = { log: target.log, warn: target.warn, error: target.error };
  for (const method of ['log', 'warn', 'error'] as const) {
    const original = originals[method];
    target[method] = (...args: unknown[]) => original.apply(target, args.map(redactArgument));
  }
  return () => { Object.assign(target, originals); };
}

/** Prints a last-resort error without its URL (or stack) and exits 1; installed for unhandled rejections and uncaught exceptions. */
export function installFatalErrorHandlers(processLike: Pick<NodeJS.Process, 'on' | 'exit'>, print: (line: string) => void = console.error): void {
  const fail = (kind: string) => (error: unknown) => {
    print(`fast lane ${kind}: ${redactError(error)}`);
    processLike.exit(1);
  };
  processLike.on('unhandledRejection', fail('unhandled rejection'));
  processLike.on('uncaughtException', fail('uncaught exception'));
}
