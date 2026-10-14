import { describe, expect, it } from 'vitest';
import { redactError, redactUrls } from './redact.js';

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
