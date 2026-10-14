import { describe, expect, it } from 'vitest';
import { installConsoleRedaction, installFatalErrorHandlers, redactError, redactUrls } from './redact.js';

describe('redact', () => {
  it('removes an http URL with a key from a viem-style message', () => {
    const message = 'HTTP request failed.\n\nURL: https://rpc.example/v2/SECRETKEY\nRequest body: {"method":"eth_getLogs"}';
    const out = redactUrls(message);
    expect(out).not.toContain('SECRETKEY');
    expect(out).toContain('URL: [redacted-url]\nRequest body');
  });
  it('removes wss URLs, also inside quotes and parentheses', () => {
    expect(redactUrls('failed (wss://node.example/ws/KEY123) and "wss://a.b/KEY456"')).toBe('failed ([redacted-url]) and "[redacted-url]"');
  });
  it('leaves text without a URL unchanged', () => {
    expect(redactUrls('connection reset')).toBe('connection reset');
  });
  it('redactError uses the message only and accepts non-Error input', () => {
    const error = new Error('bad https://x.example/KEY');
    expect(redactError(error)).toBe('bad [redacted-url]');
    expect(redactError('oops wss://x.example/KEY')).toBe('oops [redacted-url]');
    expect(redactError(42)).toBe('42');
  });
});

describe('installConsoleRedaction', () => {
  const fakeKey = 'FAKEKEY0123456789';
  function fakeConsole() {
    const lines: { method: string; args: unknown[] }[] = [];
    const target = {
      log: (...args: unknown[]) => { lines.push({ method: 'log', args }); },
      warn: (...args: unknown[]) => { lines.push({ method: 'warn', args }); },
      error: (...args: unknown[]) => { lines.push({ method: 'error', args }); },
    };
    return { target, lines };
  }

  it('redacts a URL in a string, in an Error message (without its stack) and in a nested object, for log, warn and error', () => {
    const { target, lines } = fakeConsole();
    const uninstall = installConsoleRedaction(target);
    const error = new Error(`socket closed wss://node.example/ws/${fakeKey}`);
    target.error(error);
    target.warn(`retrying https://rpc.example/v2/${fakeKey}`);
    target.log('stats', { nested: { url: `wss://node.example/${fakeKey}`, count: 3n }, cause: new Error(`https://x.example/${fakeKey}`) });
    const printed = JSON.stringify(lines);
    expect(printed).not.toContain(fakeKey);
    expect(printed).not.toContain('at '); // no stack frames
    expect(lines.map((line) => line.method)).toEqual(['error', 'warn', 'log']);
    expect(lines[0]!.args).toEqual(['socket closed [redacted-url]']);
    expect(lines[2]!.args[0]).toBe('stats');
    expect(lines[2]!.args[1]).toContain('"count":"3"');
    uninstall();
    target.log(`plain https://a.example/${fakeKey}`);
    expect(JSON.stringify(lines.at(-1))).toContain(fakeKey); // uninstalled: the original console is back
  });

  it('prints a placeholder for a circular object instead of throwing or printing it raw', () => {
    const { target, lines } = fakeConsole();
    installConsoleRedaction(target);
    const circular: Record<string, unknown> = { url: `wss://n.example/${fakeKey}` };
    circular.self = circular;
    target.error(circular);
    expect(lines[0]!.args).toEqual(['[unserializable]']);
  });

  it('a fatal handler prints the redacted error and exits 1', () => {
    const handlers: Record<string, (error: unknown) => void> = {};
    const exits: number[] = [];
    const printed: string[] = [];
    installFatalErrorHandlers({ on: ((event: string, handler: (error: unknown) => void) => { handlers[event] = handler; }) as never,
      exit: ((code: number) => { exits.push(code); }) as never }, (line) => printed.push(line));
    handlers.unhandledRejection!(new Error(`boom wss://n.example/${fakeKey}`));
    handlers.uncaughtException!(`bad https://n.example/${fakeKey}`);
    expect(printed.join('\n')).not.toContain(fakeKey);
    expect(exits).toEqual([1, 1]);
  });
});
