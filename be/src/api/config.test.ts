import { describe, expect, it } from 'vitest';
import { readApiConfig } from './config.js';

const BASE_ENV = { DATABASE_URL: 'postgres://example', FE_ORIGIN: 'http://localhost:3000', VOLUME_CURSOR_SECRET: 'test-secret' };

describe('API configuration', () => {
  it('requires database and frontend origin and defaults to a local bind', () => {
    expect(readApiConfig(BASE_ENV)).toEqual({
      databaseUrl: 'postgres://example', feOrigin: 'http://localhost:3000', host: '127.0.0.1', port: 3001,
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', volumeCursorSecret: 'test-secret',
    });
    expect(readApiConfig({ ...BASE_ENV, RH_HTTP_RPC_URL: 'https://custom.example' }).rpcUrl)
      .toBe('https://custom.example');
    expect(() => readApiConfig({ FE_ORIGIN: 'http://localhost:3000', VOLUME_CURSOR_SECRET: 'x' })).toThrow(/DATABASE_URL/);
    expect(() => readApiConfig({ DATABASE_URL: 'postgres://example', VOLUME_CURSOR_SECRET: 'x' })).toThrow(/FE_ORIGIN/);
    expect(() => readApiConfig({ DATABASE_URL: 'postgres://example', FE_ORIGIN: 'http://localhost:3000' })).toThrow(/VOLUME_CURSOR_SECRET/);
    expect(() => readApiConfig({ ...BASE_ENV, FE_ORIGIN: '*', API_PORT: '99999' })).toThrow();
  });
});
