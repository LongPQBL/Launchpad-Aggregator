import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BATCH, allowRequest, forwardRpc, resetRateLimitForTests } from './rpc-proxy';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/rpc', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
const call = (method: string) => ({ jsonrpc: '2.0', id: 1, method, params: [] });

describe('forwardRpc', () => {
  beforeEach(() => resetRateLimitForTests());

  it('forwards an allowed read call to the upstream and returns its answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"jsonrpc":"2.0","id":1,"result":"0x10"}', { status: 200 }));
    const response = await forwardRpc(post(call('eth_blockNumber')), 'https://upstream.example/key', fetchImpl as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x10' });
    expect(fetchImpl).toHaveBeenCalledWith('https://upstream.example/key', expect.objectContaining({ method: 'POST' }));
  });
  it('forwards a batch of allowed calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[]'));
    const response = await forwardRpc(post([call('eth_call'), call('eth_getBalance')]), 'https://u.example', fetchImpl as never);
    expect(response.status).toBe(200);
  });
  it('refuses a method that is not a read, without calling the upstream', async () => {
    const fetchImpl = vi.fn();
    const response = await forwardRpc(post(call('eth_sendRawTransaction')), 'https://u.example', fetchImpl as never);
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses a batch with one forbidden call, and an oversized batch', async () => {
    const fetchImpl = vi.fn();
    expect((await forwardRpc(post([call('eth_call'), call('debug_traceTransaction')]), 'https://u.example', fetchImpl as never)).status).toBe(403);
    expect((await forwardRpc(post(Array.from({ length: MAX_BATCH + 1 }, () => call('eth_call'))), 'https://u.example', fetchImpl as never)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects malformed and oversized bodies', async () => {
    const fetchImpl = vi.fn();
    expect((await forwardRpc(post('not json'), 'https://u.example', fetchImpl as never)).status).toBe(400);
    expect((await forwardRpc(post('x'.repeat(70_000)), 'https://u.example', fetchImpl as never)).status).toBe(413);
  });
  it('does not leak the upstream URL when the provider cannot be reached', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('request to https://secret.example/v1/KEY failed'));
    const response = await forwardRpc(post(call('eth_call')), 'https://secret.example/v1/KEY', fetchImpl as never);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret.example');
  });
  it('limits how many requests one client can make a minute', () => {
    const results = Array.from({ length: 241 }, () => allowRequest('1.2.3.4', 1_000));
    expect(results.slice(0, 240).every(Boolean)).toBe(true);
    expect(results[240]).toBe(false);
    expect(allowRequest('1.2.3.4', 1_000 + 61_000)).toBe(true); // a new window
    expect(allowRequest('5.6.7.8', 1_000)).toBe(true); // another client
  });
});
