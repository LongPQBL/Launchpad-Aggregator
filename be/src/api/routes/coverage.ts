import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';

export function registerCoverageRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v1/coverage', async () => deps.data.getCoverage());
}
