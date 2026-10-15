// The browser reads the chain through this app's own /api/rpc, so the RPC provider's URL (which carries an API key) stays on the server.
// Only read methods are forwarded: a wallet signs and sends its own transactions through its own provider.
const ALLOWED_METHODS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs',
  // A simulation changes no state; the transfer-fee check of the trade panel measures a token with it.
  'eth_simulateV1', 'eth_createAccessList',
]);
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 20;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 240;
export const DEFAULT_UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com';

const hits = new Map<string, { count: number; resetAt: number }>();

/** At most 240 requests a minute per client: enough for a page's reads, not enough to spend the provider's quota for someone else. */
export function allowRequest(client: string, now = Date.now()): boolean {
  const entry = hits.get(client);
  if (!entry || entry.resetAt <= now) {
    if (hits.size > 5_000) for (const [key, value] of hits) if (value.resetAt <= now) hits.delete(key);
    hits.set(client, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_REQUESTS_PER_WINDOW;
}

export function resetRateLimitForTests(): void { hits.clear(); }

function jsonError(status: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }, { status });
}

function isAllowedCall(call: unknown): boolean {
  return typeof call === 'object' && call !== null && typeof (call as { method?: unknown }).method === 'string'
    && ALLOWED_METHODS.has((call as { method: string }).method);
}

export async function forwardRpc(request: Request, upstream: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allowRequest(client)) return jsonError(429, 'Too many requests');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return jsonError(413, 'Request too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return jsonError(413, 'Request too large');
  let body: unknown;
  try { body = JSON.parse(text); } catch { return jsonError(400, 'Invalid JSON'); }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return jsonError(400, 'Invalid batch');
  if (!calls.every(isAllowedCall)) return jsonError(403, 'Method not allowed');
  try {
    const response = await fetchImpl(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, cache: 'no-store' });
    return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    // Never echo the upstream error: viem and fetch put the full URL, key included, in their messages.
    return jsonError(502, 'RPC provider unreachable');
  }
}
