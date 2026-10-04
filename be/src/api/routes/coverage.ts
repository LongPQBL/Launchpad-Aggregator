import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { coverageSchema } from '../schemas.js';

export function registerCoverageRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v1/coverage', { schema: { response: { 200: coverageSchema } } }, async () => deps.data.getCoverage());
}
