import { createPublicClient, http, webSocket, type Chain, type Log } from 'viem';
import { FAST_LANE_EVENTS, type FastLog } from './decode.js';
import type { LaneChainSource } from './runner.js';

export function toFastLog(log: Log): FastLog | null {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) return null;
  return {
    address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber, blockHash: log.blockHash,
    transactionHash: log.transactionHash, logIndex: log.logIndex, removed: log.removed,
  };
}

/**
 * Transport settings. HTTP: a short timeout and no retries, since the lane retries a lookup itself and one slow call must not hold the queue.
 * WebSocket: keep reconnecting for as long as the process lives (viem's default gives up after 5 attempts, ~10 s, and its subscriptions are
 * then gone for good); the runner's watchdog exits the process if no log arrives for a long time anyway.
 */
export const HTTP_TRANSPORT_OPTIONS = { timeout: 3_000, retryCount: 0 } as const;
export const WEBSOCKET_TRANSPORT_OPTIONS = { keepAlive: true, reconnect: { attempts: 1_000_000, delay: 2_000 }, timeout: 3_000 } as const;

/** The lane's view of the chain: WebSocket for the live log stream, plain HTTP for everything it asks for by key. */
export function createViemChainSource(chain: Chain, urls: { http: string; ws: string }): LaneChainSource {
  const rpc = createPublicClient({ chain, transport: http(urls.http, HTTP_TRANSPORT_OPTIONS) });
  const socket = createPublicClient({ chain, transport: webSocket(urls.ws, WEBSOCKET_TRANSPORT_OPTIONS) });
  return {
    async getBlock(blockNumber) {
      const block = await rpc.getBlock({ blockNumber });
      return block.number === null || block.hash === null ? null : { number: block.number, hash: block.hash, timestamp: Number(block.timestamp) };
    },
    async getTransactionSender(txHash) {
      const transaction = await rpc.getTransaction({ hash: txHash as `0x${string}` });
      return transaction.from;
    },
    async getLogs(fromBlock, toBlock) {
      const logs = await rpc.getLogs({ events: FAST_LANE_EVENTS as never, fromBlock, toBlock });
      return (logs as Log[]).flatMap((log) => toFastLog(log) ?? []);
    },
    getBlockNumber: () => rpc.getBlockNumber(),
    subscribeLogs(onLogs, onError) {
      return socket.watchEvent({
        events: FAST_LANE_EVENTS as never,
        onLogs: (logs) => onLogs((logs as Log[]).flatMap((log) => toFastLog(log) ?? [])),
        onError,
      });
    },
  };
}
