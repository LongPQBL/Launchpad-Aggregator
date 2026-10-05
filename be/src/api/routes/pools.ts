import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';
import type { PoolKey } from '../../pools/stats.js';
import { pageSchema, poolCandle, poolPage, poolSummary, poolTrade } from '../schemas.js';
import type { ApiDeps } from '../server.js';

const poolIdPattern = /^0x[0-9a-fA-F]{64}$/;
function chain(value: string): number | null {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function key(params: { chainId: string; protocol: string; poolId: string }): PoolKey | null {
  const chainId = chain(params.chainId);
  if (chainId === null || !['uniswap_v4', 'uniswap_v3', 'uniswap_v2'].includes(params.protocol)) return null;
  if (params.protocol === 'uniswap_v4' ? !poolIdPattern.test(params.poolId) : !isAddress(params.poolId)) return null;
  return { chainId, protocol: params.protocol as PoolKey['protocol'], poolId: params.poolId.toLowerCase() };
}
function token(value: string | undefined): string | null {
  return value && isAddress(value) ? value.toLowerCase() : null;
}
function listQuery(value: Record<string, string | undefined>, tokenAddress?: string) {
  const limit = value.limit === undefined ? 50 : Number(value.limit);
  const chainId = value.chainId === undefined ? undefined : chain(value.chainId);
  if (!Number.isSafeInteger(limit) || limit < 1 || chainId === null
    || (value.tokenAddress !== undefined && !token(value.tokenAddress))) return null;
  if (value.protocol !== undefined && !['uniswap_v4', 'uniswap_v3', 'uniswap_v2'].includes(value.protocol)) return null;
  return { limit: Math.min(limit, 100), ...(chainId ? { chainId } : {}),
    ...(value.cursor ? { cursor: value.cursor } : {}),
    ...(value.protocol ? { protocol: value.protocol as PoolKey['protocol'] } : {}),
    ...((tokenAddress ?? value.tokenAddress) ? { tokenAddress: token(tokenAddress ?? value.tokenAddress)! } : {}) };
}
function unavailable(reply: { code(n: number): { send(value: object): unknown } }) {
  return reply.code(503).send({ error: 'Pool source unavailable' });
}

export function registerPoolRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/pools',
    { schema: { response: { 200: poolPage } } }, async (request, reply) => {
      const query = listQuery(request.query);
      if (!query) return reply.code(400).send({ error: 'Invalid pool query' });
      if (!deps.pools) return unavailable(reply);
      try { return await deps.pools.listPools(query); }
      catch (error) { if (error instanceof Error && ['Invalid pool cursor', 'Unsupported pool protocol'].includes(error.message))
        return reply.code(400).send({ error: error.message }); throw error; }
    });
  app.get<{ Params: { chainId: string; tokenAddress: string }; Querystring: Record<string, string | undefined> }>(
    '/v1/launches/:chainId/:tokenAddress/pools', { schema: { response: { 200: poolPage } } }, async (request, reply) => {
      const chainId = chain(request.params.chainId);
      const address = token(request.params.tokenAddress);
      if (chainId === null || !address) return reply.code(404).send({ error: 'Launch not found' });
      const launch = await deps.data.getLaunch(chainId, address);
      if (!launch) return reply.code(404).send({ error: 'Launch not found' });
      const query = listQuery(request.query, address);
      if (!query) return reply.code(400).send({ error: 'Invalid pool query' });
      if (!deps.pools) return unavailable(reply);
      const excludeOfficial = request.query.excludeOfficial === 'true';
      try { return await deps.pools.listPools({ ...query, chainId, tokenAddress: address, excludeOfficial }); }
      catch (error) { if (error instanceof Error && ['Invalid pool cursor', 'Unsupported pool protocol'].includes(error.message))
        return reply.code(400).send({ error: error.message }); throw error; }
    });
  type Params = { chainId: string; protocol: string; poolId: string };
  type Query = Record<string, string | undefined>;
  app.get<{ Params: Params; Querystring: Query }>('/v1/pools/:chainId/:protocol/:poolId',
    { schema: { response: { 200: poolSummary } } }, async (request, reply) => {
      const identity = key(request.params);
      if (!identity) return reply.code(404).send({ error: 'Pool not found' });
      const displayed = request.query.displayedToken === undefined ? undefined : token(request.query.displayedToken);
      if (displayed === null) return reply.code(400).send({ error: 'Invalid displayed token' });
      if (!deps.pools) return unavailable(reply);
      return await deps.pools.getPool(identity, displayed) ?? reply.code(404).send({ error: 'Pool not found' });
    });
  app.get<{ Params: Params; Querystring: Query }>('/v1/pools/:chainId/:protocol/:poolId/trades',
    { schema: { response: { 200: pageSchema(poolTrade) } } }, async (request, reply) => {
      const identity = key(request.params);
      if (!identity) return reply.code(404).send({ error: 'Pool not found' });
      if (!deps.pools) return unavailable(reply);
      const displayedToken = await deps.pools.resolvePoolSide(identity,
        request.query.displayedToken ? token(request.query.displayedToken) ?? '' : undefined);
      if (!displayedToken) return reply.code(404).send({ error: 'Pool not found' });
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1) return reply.code(400).send({ error: 'Invalid trade limit' });
      try { return await deps.pools.listPoolTrades(identity, displayedToken,
        { limit: Math.min(limit, 100), ...(request.query.cursor ? { cursor: request.query.cursor } : {}) }); }
      catch (error) { if (error instanceof Error && error.message === 'Invalid pool trade cursor') return reply.code(400).send({ error: 'Invalid cursor' }); throw error; }
    });
  app.get<{ Params: Params; Querystring: Query }>('/v1/pools/:chainId/:protocol/:poolId/candles',
    { schema: { response: { 200: { type: 'object', properties: { items: { type: 'array', items: poolCandle }, complete: { type: 'boolean' } } } } } },
    async (request, reply) => {
      const identity = key(request.params);
      if (!identity) return reply.code(404).send({ error: 'Pool not found' });
      if (!deps.pools) return unavailable(reply);
      const displayedToken = await deps.pools.resolvePoolSide(identity,
        request.query.displayedToken ? token(request.query.displayedToken) ?? '' : undefined);
      if (!displayedToken) return reply.code(404).send({ error: 'Pool not found' });
      const interval = request.query.intervalSeconds === undefined ? 60 : Number(request.query.intervalSeconds);
      const before = request.query.before === undefined ? undefined : Number(request.query.before);
      if (![60, 300, 900, 3600, 86400].includes(interval) || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) {
        return reply.code(400).send({ error: 'Invalid candle query' });
      }
      return deps.pools.listPoolCandles(identity, displayedToken, interval, before);
    });
}
