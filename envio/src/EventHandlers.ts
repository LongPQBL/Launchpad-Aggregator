import { indexer } from "envio";

indexer.onEvent(
  { contract: "PonsV1LegacyFactory", event: "TokenLaunched" },
  async ({ event, context }) => {
    context.RawLaunch.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      deployerAddress: event.params.deployer.toLowerCase(),
      pairTokenAddress: event.params.pairToken.toLowerCase(),
      poolAddress: event.params.pool.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.contractRegister(
  { contract: "PonsV1LegacyFactory", event: "TokenLaunched" },
  async ({ event, context }) => {
    context.chain.PonsV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "PonsV3Pool", event: "Swap" },
  async ({ event, context }) => {
    context.RawSwap.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolAddress: event.srcAddress.toLowerCase(),
      sender: event.params.sender.toLowerCase(),
      recipient: event.params.recipient.toLowerCase(),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);
