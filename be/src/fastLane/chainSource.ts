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

/** The lane's view of the chain: WebSocket for the live log stream, plain HTTP for everything it asks for by key. */
export function createViemChainSource(chain: Chain, urls: { http: string; ws: string }): LaneChainSource {
  const rpc = createPublicClient({ chain, transport: http(urls.http) });
  const socket = createPublicClient({ chain, transport: webSocket(urls.ws, { keepAlive: true, reconnect: true }) });
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
