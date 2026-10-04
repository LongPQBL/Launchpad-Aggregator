import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';
import { decodeCursor } from '../cursor.js';
import { candle, launchDetail, launchSummary, pageSchema, trade } from '../schemas.js';
import type { ApiDeps, LaunchListQuery } from '../server.js';

const LIFECYCLE_STATUSES = new Set(['trading', 'swept', 'graduated', 'rescued']);

function chainId(value: string): number | null {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function listQuery(value: Record<string, string | undefined>): { limit: number; cursor?: string; chainId?: number } | null {
  const requested = value.limit === undefined ? 50 : Number(value.limit);
  if (!Number.isSafeInteger(requested) || requested < 1) return null;
  const id = value.chainId === undefined ? undefined : chainId(value.chainId);
  if (id === null) return null;
  if (value.cursor) {
    try { decodeCursor(value.cursor); } catch { return null; }
  }
  return { limit: Math.min(requested, 100), ...(value.cursor ? { cursor: value.cursor } : {}), ...(id ? { chainId: id } : {}) };
}

function launchListQuery(value: Record<string, string | undefined>): LaunchListQuery | null {
  const base = listQuery(value);
  if (!base) return null;
  const search = value.search?.trim();
  if (value.status !== undefined && !LIFECYCLE_STATUSES.has(value.status)) return null;
  const platform = value.platform?.trim();
  return { ...base, ...(search ? { search } : {}), ...(value.status ? { status: value.status } : {}), ...(platform ? { platform } : {}) };
}

function tokenParams(value: { chainId: string; tokenAddress: string }): { chainId: number; tokenAddress: string } | null {
  const id = chainId(value.chainId);
  if (id === null || !isAddress(value.tokenAddress)) return null;
  return { chainId: id, tokenAddress: value.tokenAddress.toLowerCase() };
}

export function registerLaunchRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/launches', { schema: { response: { 200: pageSchema(launchSummary) } } }, async (request, reply) => {
    const query = launchListQuery(request.query);
    if (!query) return reply.code(400).send({ error: 'Invalid launch query' });
    return deps.data.listLaunches(query);
  });

  app.get<{ Params: { chainId: string; tokenAddress: string } }>('/v1/launches/:chainId/:tokenAddress',
    { schema: { response: { 200: launchDetail } } }, async (request, reply) => {
    const identity = tokenParams(request.params);
    if (!identity) return reply.code(404).send({ error: 'Launch not found' });
    const launch = await deps.data.getLaunch(identity.chainId, identity.tokenAddress);
    return launch ?? reply.code(404).send({ error: 'Launch not found' });
    });

  app.get<{ Params: { chainId: string; tokenAddress: string }; Querystring: Record<string, string | undefined> }>(
    '/v1/launches/:chainId/:tokenAddress/trades', { schema: { response: { 200: pageSchema(trade) } } }, async (request, reply) => {
      const identity = tokenParams(request.params);
      const query = listQuery(request.query);
      if (!identity) return reply.code(404).send({ error: 'Launch not found' });
      if (!query) return reply.code(400).send({ error: 'Invalid trade query' });
      return deps.data.listTrades(identity.chainId, identity.tokenAddress, query);
    },
  );

  app.get<{ Params: { chainId: string; tokenAddress: string }; Querystring: Record<string, string | undefined> }>(
    '/v1/launches/:chainId/:tokenAddress/candles', { schema: { response: { 200: { type: 'object', properties: { items: { type: 'array', items: candle }, complete: { type: 'boolean' } } } } } }, async (request, reply) => {
      const identity = tokenParams(request.params);
      const interval = request.query.intervalSeconds === undefined ? 60 : Number(request.query.intervalSeconds);
      const before = request.query.before === undefined ? undefined : Number(request.query.before);
      if (!identity) return reply.code(404).send({ error: 'Launch not found' });
      if (![60, 300, 900, 3600, 86400].includes(interval)) return reply.code(400).send({ error: 'Invalid candle interval' });
      if (before !== undefined && (!/^\d+$/.test(request.query.before!) || !Number.isSafeInteger(before) || before < 1)) {
        return reply.code(400).send({ error: 'Invalid candle boundary' });
      }
      return deps.data.listCandles(identity.chainId, identity.tokenAddress, interval, before);
    },
  );
}
