import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeAbiParameters, encodeEventTopics, type Chain } from 'viem';
import { v3SwapEvent } from '../launchpads/pons/v1/abi.js';
import { createViemChainSource } from './chainSource.js';

// A fake node that speaks just enough JSON-RPC over WebSocket: it accepts eth_subscribe and pushes a Swap log on demand.
const trader = '0x1111111111111111111111111111111111111111';
const pool = '0x2000000000000000000000000000000000000abc';
const topics = encodeEventTopics({ abi: [v3SwapEvent], eventName: 'Swap', args: { sender: trader, recipient: trader } });
const data = encodeAbiParameters(
  [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [100n, -200n, 79228162514264337593543950336n, 5n, -12]);
const chain = { id: 4663, name: 'fake', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } } as Chain;

let server: WebSocketServer | undefined;
afterEach(async () => {
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('WebSocket log subscription across a dropped connection', () => {
  it('subscribes again by itself after the socket reconnects and keeps delivering logs', async () => {
    const sockets: WebSocket[] = [];
    let subscribeCalls = 0;
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as { id: number; method: string };
        if (request.method === 'eth_subscribe') {
          subscribeCalls += 1;
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: `0xsub${subscribeCalls}` }));
        } else socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
      });
    });
    const port = (server.address() as { port: number }).port;
    const push = (blockNumber: number) => sockets.at(-1)!.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: {
      subscription: `0xsub${subscribeCalls}`,
      result: { address: pool, topics, data, blockNumber: `0x${blockNumber.toString(16)}`, blockHash: `0x${'b1'.repeat(32)}`,
        transactionHash: `0x${'a1'.repeat(32)}`, transactionIndex: '0x0', logIndex: '0x1', removed: false } } }));

    const received: bigint[] = [];
    const source = createViemChainSource(chain, { http: 'http://127.0.0.1:1', ws: `ws://127.0.0.1:${port}` });
    const stop = source.subscribeLogs((logs) => { for (const log of logs) received.push(log.blockNumber); }, () => {});

    await waitFor(() => subscribeCalls === 1);
    push(10);
    await waitFor(() => received.length === 1);

    sockets[0]!.terminate(); // the node (or the network) drops the connection
    await waitFor(() => subscribeCalls === 2, 15_000);
    push(11);
    await waitFor(() => received.length === 2);
    expect(received).toEqual([10n, 11n]);
    stop();
  }, 30_000);
});

describe('block and sender lookups', () => {
  it('go over the WebSocket (no new HTTP connection) and return every sender of the block', async () => {
    const methods: string[] = [];
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const request = JSON.parse(String(raw)) as { id: number; method: string };
      methods.push(request.method);
      const block = { number: '0x10', hash: `0x${'b1'.repeat(32)}`, timestamp: '0x65', transactions: [
        { hash: `0x${'a1'.repeat(32)}`, from: '0x1111111111111111111111111111111111111111', blockNumber: '0x10', blockHash: `0x${'b1'.repeat(32)}`, transactionIndex: '0x0', nonce: '0x0', value: '0x0', gas: '0x0', input: '0x', type: '0x0' },
        { hash: `0x${'a2'.repeat(32)}`, from: '0x2222222222222222222222222222222222222222', blockNumber: '0x10', blockHash: `0x${'b1'.repeat(32)}`, transactionIndex: '0x1', nonce: '0x0', value: '0x0', gas: '0x0', input: '0x', type: '0x0' }] };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_getBlockByNumber' ? block : null }));
    }));
    const port = (server.address() as { port: number }).port;
    const source = createViemChainSource(chain, { http: 'http://127.0.0.1:1', ws: `ws://127.0.0.1:${port}` });
    const header = await source.getBlock(16n);
    expect(header?.timestamp).toBe(0x65);
    expect(header?.senders?.get(`0x${'a2'.repeat(32)}`)).toBe('0x2222222222222222222222222222222222222222');
    expect(methods).toContain('eth_getBlockByNumber');
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
