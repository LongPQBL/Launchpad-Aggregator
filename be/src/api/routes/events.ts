import type { FastifyInstance } from 'fastify';
import type { ApiEventBus } from '../events.js';

export function registerEventsRoute(app: FastifyInstance, events: ApiEventBus): void {
  app.get('/v1/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = events.subscribe((event) => {
      const { id, type, ...resource } = event;
      reply.raw.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(resource)}\n\n`);
    });
    request.raw.on('close', unsubscribe);
  });
}
