import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from './csp';

describe('buildContentSecurityPolicy', () => {
  const base = { nonce: 'abc123', isDev: false, connectUrls: ['http://127.0.0.1:3001/x', undefined, 'not a url'] };

  it('only runs scripts that carry the request nonce, with no eval or inline allowance in production', () => {
    const csp = buildContentSecurityPolicy(base);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('limits connections to this origin plus the configured API and RPC origins', () => {
    expect(buildContentSecurityPolicy(base)).toContain("connect-src 'self' http://127.0.0.1:3001");
  });

  it('allows eval and websockets only in development', () => {
    const dev = buildContentSecurityPolicy({ ...base, isDev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain('ws:');
    expect(buildContentSecurityPolicy(base)).not.toContain('ws:');
  });
});
