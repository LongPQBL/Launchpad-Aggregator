import { describe, expect, it } from 'vitest';
import { readApiConfig } from './config.js';

describe('API configuration', () => {
  it('requires database and frontend origin and defaults to a local bind', () => {
    expect(readApiConfig({ DATABASE_URL: 'postgres://example', FE_ORIGIN: 'http://localhost:3000' })).toEqual({
      databaseUrl: 'postgres://example', feOrigin: 'http://localhost:3000', host: '127.0.0.1', port: 3001,
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    });
    expect(readApiConfig({ DATABASE_URL: 'postgres://example', FE_ORIGIN: 'http://localhost:3000', RH_HTTP_RPC_URL: 'https://custom.example' }).rpcUrl)
      .toBe('https://custom.example');
    expect(() => readApiConfig({ FE_ORIGIN: 'http://localhost:3000' })).toThrow(/DATABASE_URL/);
    expect(() => readApiConfig({ DATABASE_URL: 'postgres://example' })).toThrow(/FE_ORIGIN/);
    expect(() => readApiConfig({ DATABASE_URL: 'postgres://example', FE_ORIGIN: '*', API_PORT: '99999' })).toThrow();
  });
});
