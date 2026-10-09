import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';
import { walletPositions } from '../schemas.js';
import type { ApiDeps } from '../server.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function registerWalletRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { address: string }; Querystring: { chainId?: string; limit?: string } }>('/v1/wallets/:address/positions',
    { schema: { response: { 200: walletPositions } } }, async (request, reply) => {
      const chainId = request.query.chainId === undefined ? undefined : Number(request.query.chainId);
      const limit = request.query.limit === undefined ? DEFAULT_LIMIT : Number(request.query.limit);
      if (!isAddress(request.params.address) || !Number.isSafeInteger(limit) || limit < 1
        || (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId < 1))) {
        return reply.code(400).send({ error: 'Invalid wallet query' });
      }
      if (!deps.wallets) return reply.code(503).send({ error: 'Wallet positions unavailable' });
      return deps.wallets.listPositions(chainId, request.params.address, Math.min(limit, MAX_LIMIT));
    });
}
