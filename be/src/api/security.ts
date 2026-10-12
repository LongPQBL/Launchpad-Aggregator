import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyError, FastifyInstance } from 'fastify';

export interface SecurityOptions {
  /** Requests per IP per minute across the whole API. */
  globalPerMinute?: number;
  /** Stricter budget for routes that fan out into many RPC reads. */
  heavyPerMinute?: number;
  maxEventStreams?: number;
  maxEventStreamsPerIp?: number;
}

export const DEFAULT_GLOBAL_PER_MINUTE = 600;
export const DEFAULT_HEAVY_PER_MINUTE = 20;

/** Route-level config for an endpoint whose uncached call costs dozens of RPC reads. */
export function heavyRoute(heavyPerMinute: number): { config: { rateLimit: { max: number; timeWindow: string } } } {
  return { config: { rateLimit: { max: heavyPerMinute, timeWindow: '1 minute' } } };
}

export async function registerSecurity(app: FastifyInstance, options: SecurityOptions = {}): Promise<void> {
  // The API only serves JSON and an SSE stream, so nothing it returns should ever be rendered or framed.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, { global: true, max: options.globalPerMinute ?? DEFAULT_GLOBAL_PER_MINUTE, timeWindow: '1 minute' });
  // A raw exception message can carry SQL text, RPC URLs or file paths; clients only get a generic body for 5xx.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(statusCode).send({ error: 'Internal server error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });
}
