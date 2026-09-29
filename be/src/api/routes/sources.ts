import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';

export function registerSourcesRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v1/sources', async () => ({ items: await deps.data.listSources() }));
}
