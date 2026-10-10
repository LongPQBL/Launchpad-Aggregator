import type { FastifyInstance } from 'fastify';
import { searchResults } from '../schemas.js';
import { MIN_SEARCH_LENGTH } from '../searchStore.js';
import type { ApiDeps } from '../server.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_QUERY_LENGTH = 100;

export function registerSearchRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>('/v1/search', { schema: { response: { 200: searchResults } } }, async (request, reply) => {
    const query = request.query.q?.trim() ?? '';
    const chainId = (request.query as { chainId?: string }).chainId;
    const chains = chainId === undefined ? undefined : chainId.split(',').map(Number);
    const requested = request.query.limit === undefined ? DEFAULT_LIMIT : Number(request.query.limit);
    if (query.length < MIN_SEARCH_LENGTH || query.length > MAX_QUERY_LENGTH || !Number.isSafeInteger(requested) || requested < 1
      || (chains !== undefined && (chains.length === 0 || chains.some((id) => !Number.isSafeInteger(id) || id < 1)))) {
      return reply.code(400).send({ error: 'Invalid search query' });
    }
    if (!deps.search) return reply.code(503).send({ error: 'Search unavailable' });
    return deps.search.search(query, Math.min(requested, MAX_LIMIT), chains);
  });
}
