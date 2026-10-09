import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';
import { decodeCursor } from '../cursor.js';
import { InvalidVolumeCursorError } from '../volumeCursor.js';
import { InvalidMetricCursorError, type LaunchSort, type SortDirection } from '../metricCursor.js';
import { VolumeRankingUnavailableError } from '../../market/launchVolume/state.js';
import { candle, globalTransaction, launchDetail, launchSummary, pageSchema, trade, transaction } from '../schemas.js';
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
  const requested = value.limit === undefined ? 50 : Number(value.limit);
  if (!Number.isSafeInteger(requested) || requested < 1) return null;
  const ids = value.chainId?.split(',').map(chainId);
  if (ids?.some((id) => id === null) || ids?.length === 0) return null;
  const id = ids?.length === 1 ? ids[0]! : ids as number[] | undefined;
  const search = value.search?.trim();
  if (value.status !== undefined && !LIFECYCLE_STATUSES.has(value.status)) return null;
  const platforms = value.platform?.split(',').map((item) => item.trim());
  if (platforms?.some((item) => !item)) return null;
  const platform = platforms?.length === 1 ? platforms[0] : platforms;
  const allowedSorts = new Set<LaunchSort>(['volume24hUsd', 'recent', 'fdvUsd', 'tvlUsd', 'change1h', 'change1d']);
  if (value.sort !== undefined && !allowedSorts.has(value.sort as LaunchSort)) return null;
  if (value.direction !== undefined && value.direction !== 'asc' && value.direction !== 'desc') return null;
  const sort = value.sort as LaunchSort | undefined;
  const direction = value.direction as SortDirection | undefined;
  // Only default recency uses the plain block/tx/log cursor. Volume uses a signed
  // cursor; the other metric sorts use an offset cursor, both validated in the store.
  if (value.cursor && (sort === undefined || sort === 'recent') && (direction === undefined || direction === 'asc')) {
    try { decodeCursor(value.cursor); } catch { return null; }
  }
  return {
    limit: Math.min(requested, 100), ...(value.cursor ? { cursor: value.cursor } : {}), ...(id ? { chainId: id } : {}),
    ...(search ? { search } : {}), ...(value.status ? { status: value.status } : {}), ...(platform ? { platform } : {}),
    ...(sort ? { sort } : {}), ...(direction ? { direction } : {}),
  };
}

function tokenParams(value: { chainId: string; tokenAddress: string }): { chainId: number; tokenAddress: string } | null {
  const id = chainId(value.chainId);
  if (id === null || !isAddress(value.tokenAddress)) return null;
  return { chainId: id, tokenAddress: value.tokenAddress.toLowerCase() };
}

export function registerLaunchRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // Latest official trades across every launch (the Explore "Transactions" feed).
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/transactions', { schema: { response: { 200: pageSchema(globalTransaction) } } }, async (request, reply) => {
    // chainId may be one id or a comma-separated list, like /v1/launches.
    const ids = request.query.chainId?.split(',').map(chainId);
    if (ids?.some((id) => id === null)) return reply.code(400).send({ error: 'Invalid transaction query' });
    const query = listQuery({ ...request.query, chainId: undefined });
    if (!query) return reply.code(400).send({ error: 'Invalid transaction query' });
    if (ids) (query as { chainId?: number | number[] }).chainId = ids as number[];
    if (!deps.data.listAllTransactions) return reply.code(503).send({ error: 'Transactions feed unavailable' });
    return deps.data.listAllTransactions(query);
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/launches', { schema: { response: { 200: pageSchema(launchSummary) } } }, async (request, reply) => {
    const query = launchListQuery(request.query);
    if (!query) return reply.code(400).send({ error: 'Invalid launch query' });
    try {
      return await deps.data.listLaunches(query);
    } catch (error) {
      // The signed volume24hUsd cursor's format/tamper/expiry/sort-mismatch validation, and the
      // "pinned row no longer exists in the current ranking" case, both happen inside the store
      // (decodeVolumeCursor needs VOLUME_CURSOR_SECRET, not available to this route-level parser) —
      // either throws InvalidVolumeCursorError, which is the client's fault, never a 500
      // (final review, Important 2).
      if (error instanceof InvalidVolumeCursorError || error instanceof InvalidMetricCursorError) return reply.code(400).send({ error: 'Invalid cursor' });
      if (error instanceof VolumeRankingUnavailableError) {
        return reply.code(503).header('Retry-After', '30').send({ error: 'Launch volume ranking is temporarily unavailable' });
      }
      throw error;
    }
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
    '/v1/launches/:chainId/:tokenAddress/transactions', { schema: { response: { 200: pageSchema(transaction) } } }, async (request, reply) => {
      const identity = tokenParams(request.params);
      const query = listQuery(request.query);
      if (!identity) return reply.code(404).send({ error: 'Launch not found' });
      if (!query) return reply.code(400).send({ error: 'Invalid transaction query' });
      return deps.data.listTransactions(identity.chainId, identity.tokenAddress, query);
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
      const currency = request.query.currency ?? 'quote';
      if (currency !== 'quote' && currency !== 'usd') return reply.code(400).send({ error: 'Invalid candle currency' });
      if (currency === 'usd') return deps.data.listUsdCandles(identity.chainId, identity.tokenAddress, interval, before);
      return deps.data.listCandles(identity.chainId, identity.tokenAddress, interval, before);
    },
  );
}
