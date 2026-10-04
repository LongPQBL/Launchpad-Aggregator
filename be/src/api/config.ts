export interface ApiConfig { databaseUrl: string; feOrigin: string; host: string; port: number; rpcUrl: string; volumeCursorSecret: string }

export function readApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const databaseUrl = environment.DATABASE_URL;
  const feOrigin = environment.FE_ORIGIN;
  const host = environment.API_HOST ?? '127.0.0.1';
  const port = environment.API_PORT === undefined ? 3001 : Number(environment.API_PORT);
  const rpcUrl = environment.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
  const volumeCursorSecret = environment.VOLUME_CURSOR_SECRET;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!feOrigin || feOrigin === '*') throw new Error('FE_ORIGIN must be a specific browser origin');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
  // Fail fast at startup, not on the first sort=volume24hUsd request (final review, Important 3) —
  // a missing secret previously only surfaced as a 500 on the home page's default tab.
  if (!volumeCursorSecret) throw new Error('VOLUME_CURSOR_SECRET is required');
  return { databaseUrl, feOrigin, host, port, rpcUrl, volumeCursorSecret };
}
