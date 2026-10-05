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
      factoryAddress: event.srcAddress.toLowerCase(),
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

// Same TokenLaunched event shape as PonsV1LegacyFactory, a different deployed factory instance
// (be/src/launchpads/pons/sourceRegistry.ts's 'pons-v1-active') — shares the RawLaunch entity and
// the PonsV3Pool wildcard pool registration; only factoryAddress differs per row, which the sync
// layer uses to attribute each launch to the right FactorySource.
indexer.onEvent(
  { contract: "PonsV1ActiveFactory", event: "TokenLaunched" },
  async ({ event, context }) => {
    context.RawLaunch.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      deployerAddress: event.params.deployer.toLowerCase(),
      pairTokenAddress: event.params.pairToken.toLowerCase(),
      poolAddress: event.params.pool.toLowerCase(),
      factoryAddress: event.srcAddress.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.contractRegister(
  { contract: "PonsV1ActiveFactory", event: "TokenLaunched" },
  async ({ event, context }) => {
    context.chain.PonsV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "PonsV3Pool", event: "Swap" },
  async ({ event, context }) => {
    if (!event.transaction.from) {
      throw new Error(`Missing transaction.from for swap ${event.transaction.hash}`);
    }
    context.RawSwap.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolAddress: event.srcAddress.toLowerCase(),
      txFrom: event.transaction.from.toLowerCase(),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "TokenLaunchedV2" },
  async ({ event, context }) => {
    context.RawLaunchV2.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      curveAddress: event.params.curve.toLowerCase(),
      deployerAddress: event.params.deployer.toLowerCase(),
      pairTokenAddress: event.params.pairToken.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "LaunchSwept" },
  async ({ event, context }) => {
    context.RawLifecycleTransition.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      phase: 1,
      kind: "swept",
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "PoolGraduated" },
  async ({ event, context }) => {
    context.RawLifecycleTransition.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      phase: 2,
      kind: "graduated",
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Factory", event: "LaunchGraduationRescued" },
  async ({ event, context }) => {
    context.RawLifecycleTransition.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      tokenAddress: event.params.token.toLowerCase(),
      phase: 3,
      kind: "rescued",
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.contractRegister(
  { contract: "PonsV2Factory", event: "TokenLaunchedV2" },
  async ({ event, context }) => {
    context.chain.PonsV2Curve.add(event.params.curve);
  },
);

indexer.onEvent(
  { contract: "PonsV2Curve", event: "CurveBuy" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for curve buy ${event.transaction.hash}`);
    context.RawCurveTrade.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      curveAddress: event.srcAddress.toLowerCase(),
      side: "buy",
      tokenAmountRaw: event.params.tokensOut,
      quoteAmountRaw: event.params.quoteIn,
      feeRaw: event.params.fee,
      taxRaw: event.params.tax,
      txFrom: event.transaction.from.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Curve", event: "CurveSell" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for curve sell ${event.transaction.hash}`);
    context.RawCurveTrade.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      curveAddress: event.srcAddress.toLowerCase(),
      side: "sell",
      tokenAmountRaw: event.params.tokensIn,
      quoteAmountRaw: event.params.quoteOut,
      feeRaw: event.params.fee,
      taxRaw: event.params.tax,
      txFrom: event.transaction.from.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "PonsV2Curve", event: "BuybackLocked" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for buyback ${event.transaction.hash}`);
    context.RawCurveBuyback.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      curveAddress: event.srcAddress.toLowerCase(),
      quoteSpentRaw: event.params.quoteSpent,
      tokensLockedRaw: event.params.tokensLocked,
      txFrom: event.transaction.from.toLowerCase(),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "UniswapV4PoolManager", event: "Initialize" },
  async ({ event, context }) => {
    context.RawV4Initialize.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolId: event.params.id.toLowerCase(),
      currency0: event.params.currency0.toLowerCase(),
      currency1: event.params.currency1.toLowerCase(),
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      hooks: event.params.hooks.toLowerCase(),
      sqrtPriceX96: event.params.sqrtPriceX96,
      tick: Number(event.params.tick),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: "UniswapV4PoolManager", event: "V4Swap" },
  async ({ event, context }) => {
    if (!event.transaction.from) throw new Error(`Missing transaction.from for V4 swap ${event.transaction.hash}`);
    context.RawV4Swap.set({
      id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
      chainId: event.chainId,
      poolId: event.params.id.toLowerCase(),
      sender: event.params.sender.toLowerCase(),
      txFrom: event.transaction.from.toLowerCase(),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      // liquidity/tick: kept in the schema (see RawSwap's comment above for why removing fields
      // requires a full reindex) but not stored — same unused-Uniswap-V3-internals reasoning.
      liquidity: 0n,
      tick: 0,
      fee: Number(event.params.fee),
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

// All-pool V3/V2 sources are registered only from the canonical Uniswap factories.
indexer.onEvent({ contract: "UniswapV3Factory", event: "PoolCreated" }, async ({ event, context }) => {
  context.RawV3PoolCreated.set({
    id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
    chainId: event.chainId, factoryAddress: event.srcAddress.toLowerCase(),
    poolAddress: event.params.pool.toLowerCase(), token0: event.params.token0.toLowerCase(),
    token1: event.params.token1.toLowerCase(), fee: Number(event.params.fee),
    tickSpacing: Number(event.params.tickSpacing), blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash, txHash: event.transaction.hash, logIndex: event.logIndex,
  });
});
indexer.contractRegister({ contract: "UniswapV3Factory", event: "PoolCreated" }, async ({ event, context }) => {
  context.chain.UniswapV3Pool.add(event.params.pool);
});
indexer.onEvent({ contract: "UniswapV3Pool", event: "V3Swap" }, async ({ event, context }) => {
  if (!event.transaction.from) throw new Error(`Missing transaction.from for V3 swap ${event.transaction.hash}`);
  context.RawV3Swap.set({
    id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
    chainId: event.chainId, poolAddress: event.srcAddress.toLowerCase(),
    txFrom: event.transaction.from.toLowerCase(), sender: event.params.sender.toLowerCase(),
    amount0: event.params.amount0, amount1: event.params.amount1,
    sqrtPriceX96: event.params.sqrtPriceX96, fee: 0,
    blockNumber: BigInt(event.block.number), blockHash: event.block.hash,
    txHash: event.transaction.hash, logIndex: event.logIndex, timestamp: event.block.timestamp,
  });
});
indexer.onEvent({ contract: "UniswapV2Factory", event: "PairCreated" }, async ({ event, context }) => {
  context.RawV2PairCreated.set({
    id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
    chainId: event.chainId, factoryAddress: event.srcAddress.toLowerCase(),
    pairAddress: event.params.pair.toLowerCase(), token0: event.params.token0.toLowerCase(),
    token1: event.params.token1.toLowerCase(), blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash, txHash: event.transaction.hash, logIndex: event.logIndex,
  });
});
indexer.contractRegister({ contract: "UniswapV2Factory", event: "PairCreated" }, async ({ event, context }) => {
  context.chain.UniswapV2Pair.add(event.params.pair);
});
indexer.onEvent({ contract: "UniswapV2Pair", event: "V2Swap" }, async ({ event, context }) => {
  if (!event.transaction.from) throw new Error(`Missing transaction.from for V2 swap ${event.transaction.hash}`);
  context.RawV2Swap.set({
    id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
    chainId: event.chainId, pairAddress: event.srcAddress.toLowerCase(),
    txFrom: event.transaction.from.toLowerCase(), sender: event.params.sender.toLowerCase(),
    amount0In: event.params.amount0In, amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out, amount1Out: event.params.amount1Out,
    blockNumber: BigInt(event.block.number), blockHash: event.block.hash,
    txHash: event.transaction.hash, logIndex: event.logIndex, timestamp: event.block.timestamp,
  });
});
indexer.onEvent({ contract: "UniswapV2Pair", event: "V2Sync" }, async ({ event, context }) => {
  context.RawV2Sync.set({
    id: `${event.chainId}-${event.block.hash}-${event.transaction.hash}-${event.logIndex}`,
    chainId: event.chainId, pairAddress: event.srcAddress.toLowerCase(),
    reserve0: event.params.reserve0, reserve1: event.params.reserve1,
    blockNumber: BigInt(event.block.number), blockHash: event.block.hash,
    txHash: event.transaction.hash, logIndex: event.logIndex,
  });
});
