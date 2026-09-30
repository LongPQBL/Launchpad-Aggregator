import type { Address, Hash } from 'viem';

// One eth_getBlock(number, includeTransactions: true) call yields both the block timestamp and
// every transaction's sender — replacing what used to be a separate getBlock (timestamp) call
// plus a separate getTransaction (trader) call per unique trade, roughly halving RPC calls for
// trade-decoding sources.
export interface BlockTradeData {
  timestamp: number;
  traders: ReadonlyMap<Hash, Address>;
}

export type GetBlockData = (blockNumber: bigint) => Promise<BlockTradeData>;

// Batch form: fetches many blocks' data in as few HTTP round trips as possible (see
// indexer/blockDataBatch.ts), rather than one round trip per block.
export type GetBlocksData = (blockNumbers: readonly bigint[]) => Promise<ReadonlyMap<bigint, BlockTradeData>>;
