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
