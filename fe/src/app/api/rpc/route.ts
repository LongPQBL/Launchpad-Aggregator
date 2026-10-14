import { DEFAULT_UPSTREAM, forwardRpc } from '@/lib/rpc-proxy';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return forwardRpc(request, process.env.RH_HTTP_RPC_URL || DEFAULT_UPSTREAM);
}
