import type { FastifyInstance } from 'fastify';
import type { ApiEventBus } from '../events.js';
import type { SecurityOptions } from '../security.js';

const MAX_STREAMS = 500;
const MAX_STREAMS_PER_IP = 10;
const HEARTBEAT_MS = 25_000;

export function registerEventsRoute(app: FastifyInstance, events: ApiEventBus, security: SecurityOptions = {}): void {
  const limits = { total: security.maxEventStreams ?? MAX_STREAMS, perIp: security.maxEventStreamsPerIp ?? MAX_STREAMS_PER_IP };
  const perIp = new Map<string, number>();
  let open = 0;
  app.get('/v1/events', (request, reply) => {
    // Each stream holds a socket for as long as the client wants; without a cap one host could exhaust them.
    const ip = request.ip;
    if (open >= limits.total || (perIp.get(ip) ?? 0) >= limits.perIp) {
      return reply.code(429).send({ error: 'Too many open event streams' });
    }
    open += 1;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    reply.hijack();
    // reply.hijack() bypasses Fastify's onSend pipeline (including @fastify/cors), so headers
    // it already computed via getHeaders() must be copied onto the raw response by hand.
    const corsHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (typeof value === 'string') corsHeaders[key] = value;
    }
    reply.raw.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = events.subscribe((event) => {
      const { id, type, ...resource } = event;
      reply.raw.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(resource)}\n\n`);
    });
    // A comment line keeps proxies from dropping an idle stream and lets a dead peer surface as a write error.
    const heartbeat = setInterval(() => { reply.raw.write(': ping\n\n'); }, HEARTBEAT_MS);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      unsubscribe();
      open -= 1;
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) perIp.delete(ip); else perIp.set(ip, remaining);
    };
    request.raw.on('close', release);
    reply.raw.on('error', release);
  });
}
