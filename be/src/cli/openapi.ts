import { readFileSync, writeFileSync } from 'node:fs';
import { createApiServer } from '../api/server.js';

const unavailable = async (): Promise<never> => { throw new Error('OpenAPI generation must not query data'); };
const app = await createApiServer({
  feOrigin: 'http://localhost:3000',
  pools: { listPools: unavailable, getPool: unavailable, resolvePoolSide: unavailable,
    listPoolTrades: unavailable, listPoolCandles: unavailable },
  data: { listSources: unavailable, getCoverage: unavailable, listLaunches: unavailable,
    getLaunch: unavailable, listTrades: unavailable, listTransactions: unavailable, listCandles: unavailable, listUsdCandles: unavailable },
});
const document = `${JSON.stringify(app.swagger(), null, 2)}\n`;
const path = new URL('../../openapi.json', import.meta.url);
try {
  if (process.argv.includes('--write')) writeFileSync(path, document);
  else if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== document) throw new Error('OpenAPI document is stale; run npm run openapi:write -w be');
  } else process.stdout.write(document);
} finally {
  await app.close();
}
