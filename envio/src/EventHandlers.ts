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
      // sender/recipient/liquidity/tick: kept in the schema (removing them requires a full
      // reindex — confirmed against the real indexer, Envio's incompatible-schema check compares
      // its own stored entity fingerprint, not the live table) but not worth storing real values —
      // be/src/envioSync's hydrateV1SwapFromDecoded never reads them (price comes from
      // sqrtPriceX96; trader comes from txFrom, not the event's sender/recipient params), and
      // liquidity/tick are Uniswap V3 concentrated-liquidity-math internals, not token amounts
      // (confirmed in the Pons TVL correction work: naively using them was off by ~20 orders of
      // magnitude). Writing cheap constants here instead of the real decoded values stops this
      // 12M+ row table from growing on these columns going forward.
      sender: "",
      recipient: "",
      txFrom: event.transaction.from.toLowerCase(),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: 0,
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
