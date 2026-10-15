import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Token logos are IPFS images chosen by whoever launched the token: often hundreds of kilobytes, served by slow public gateways (4-6 s each).
// The browser asks this app instead: the image is fetched once (only from the fixed gateways below, so a request can never make the server fetch
// an arbitrary URL), shrunk to a 128 px WebP, kept on disk, and served with a long cache. The gateway sees this server, not the visitor.
const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'] as const;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const SIZE = 128;
const FAILURE_TTL_MS = 60_000;
const MEMORY_ENTRIES = 500;
const CID_PATH_PATTERN = /^[A-Za-z0-9]{20,100}(\/[A-Za-z0-9._-]{1,100}){0,2}$/;

export function parseLogoCid(raw: string | null): string | null {
  return raw !== null && CID_PATH_PATTERN.test(raw) && !raw.includes('..') ? raw : null;
}

const memory = new Map<string, Buffer>();
const failures = new Map<string, number>();
const inFlight = new Map<string, Promise<Buffer | null>>();

function cacheDir(): string { return process.env.LOGO_CACHE_DIR ?? path.join(tmpdir(), 'launchpad-logos'); }
function cachePath(cid: string): string { return path.join(cacheDir(), `${createHash('sha256').update(cid).digest('hex')}.webp`); }

async function fetchFromGateways(cid: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const controllers: AbortController[] = [];
  try {
    return await Promise.any(GATEWAYS.map(async (gateway) => {
      const controller = new AbortController();
      controllers.push(controller);
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(gateway + cid, { signal: controller.signal, redirect: 'error', headers: { accept: 'image/*' } });
        if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('not an image');
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_INPUT_BYTES) throw new Error('too large');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_INPUT_BYTES) throw new Error('too large');
        return bytes;
      } finally { clearTimeout(timer); }
    }));
  } finally { for (const controller of controllers) controller.abort(); }
}

async function shrink(input: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(input, { limitInputPixels: 16_000_000, animated: false }).resize(SIZE, SIZE, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
}

/** The logo for an IPFS CID (with an optional path) as a small WebP, or null when no gateway has a usable image. */
export async function getLogo(cid: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Buffer | null> {
  const cached = memory.get(cid);
  if (cached) { memory.delete(cid); memory.set(cid, cached); return cached; }
  const failedAt = failures.get(cid);
  if (failedAt !== undefined && now - failedAt < FAILURE_TTL_MS) return null;
  const pending = inFlight.get(cid);
  if (pending) return pending;
  const work = (async (): Promise<Buffer | null> => {
    try {
      const onDisk = await readFile(cachePath(cid)).catch(() => null);
      const image = onDisk ?? await shrink(await fetchFromGateways(cid, fetchImpl));
      if (onDisk === null) {
        await mkdir(cacheDir(), { recursive: true });
        await writeFile(cachePath(cid), image).catch(() => undefined);
      }
      memory.set(cid, image);
      if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string);
      failures.delete(cid);
      return image;
    } catch {
      failures.set(cid, now);
      return null;
    } finally { inFlight.delete(cid); }
  })();
  inFlight.set(cid, work);
  return work;
}

export function resetLogoCachesForTests(): void { memory.clear(); failures.clear(); inFlight.clear(); }

const hits = new Map<string, { count: number; resetAt: number }>();
/** At most 600 logo requests a minute per client (a list page asks for about fifty). */
export function allowLogoRequest(client: string, now = Date.now()): boolean {
  const entry = hits.get(client);
  if (!entry || entry.resetAt <= now) { hits.set(client, { count: 1, resetAt: now + 60_000 }); return true; }
  entry.count += 1;
  return entry.count <= 600;
}
