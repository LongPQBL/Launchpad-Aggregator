import { allowLogoRequest, getLogo, parseLogoCid } from '@/lib/logo-proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allowLogoRequest(client)) return new Response('Too many requests', { status: 429 });
  const cid = parseLogoCid(new URL(request.url).searchParams.get('c'));
  if (cid === null) return new Response('Invalid logo', { status: 400 });
  const image = await getLogo(cid);
  if (image === null) return new Response('Logo unavailable', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
  // The CID names the content, so the answer never changes.
  return new Response(new Uint8Array(image), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' } });
}
