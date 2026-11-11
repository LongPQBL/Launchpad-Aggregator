import { indexer } from "envio";

function tokenId(chainId: number, address: string): string {
  return `${chainId}-${address.toLowerCase()}`;
}

function poolId(chainId: number, kind: string, address: string): string {
  return `${chainId}-${kind}-${address.toLowerCase()}`;
}

interface TokenReader {
  SeedLaunchToken: { get(id: string): Promise<unknown> };
}

interface SeedContext extends TokenReader {
  RawLaunch: { set(value: {
    id: string; chainId: number; tokenAddress: string; deployerAddress: string; pairTokenAddress: string;
    poolAddress: string; factoryAddress: string; blockNumber: bigint; blockHash: string; txHash: string; logIndex: number;
  }): void };
  RawLaunchV2: { set(value: {
    id: string; chainId: number; tokenAddress: string; curveAddress: string; deployerAddress: string;
    pairTokenAddress: string; blockNumber: bigint; blockHash: string; txHash: string; logIndex: number;
  }): void };
  SeededPool: { set(value: {
    id: string; chainId: number; kind: string; poolAddress: string; sourceAddress: string;
    currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
    blockNumber: bigint; blockHash: string; txHash: string; logIndex: number;
  }): void };
  SeedLaunchToken: TokenReader['SeedLaunchToken'] & {
    set(value: { id: string; chainId: number; tokenAddress: string }): void;
  };
}

interface SeedPoolEvent {
  chainId: number;
  block: { number: number; hash: string };
  transaction: { hash: string };
  logIndex: number;
}

async function isPonsToken(context: TokenReader, chainId: number, a: string, b: string): Promise<boolean> {
  const [tokenA, tokenB] = await Promise.all([
    context.SeedLaunchToken.get(tokenId(chainId, a)),
    context.SeedLaunchToken.get(tokenId(chainId, b)),
  ]);
  return tokenA !== undefined || tokenB !== undefined;
}

function savePool(context: SeedContext, chainId: number, kind: string, address: string, sourceAddress: string,
  event: SeedPoolEvent, poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): void {
  const normalized = address.toLowerCase();
  context.SeededPool.set({
    id: poolId(chainId, kind, normalized),
    chainId,
    kind,
    poolAddress: normalized,
    sourceAddress: sourceAddress.toLowerCase(),
    currency0: poolKey.currency0.toLowerCase(),
    currency1: poolKey.currency1.toLowerCase(),
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: poolKey.hooks.toLowerCase(),
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  });
}

function saveLaunchToken(context: SeedContext, chainId: number, token: string): void {
  const normalized = token.toLowerCase();
  context.SeedLaunchToken.set({
    id: tokenId(chainId, normalized),
    chainId,
    tokenAddress: normalized,
  });
}

for (const contract of ["PonsV1LegacyFactory", "PonsV1ActiveFactory"] as const) {
  indexer.onEvent({ contract, event: "TokenLaunched" }, async ({ event, context }) => {
    saveLaunchToken(context, event.chainId, event.params.token);
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
    savePool(context, event.chainId, "pons_v1", event.params.pool, event.srcAddress, event, {
      currency0: event.params.token, currency1: event.params.pairToken,
      fee: 0, tickSpacing: 0, hooks: "0x0000000000000000000000000000000000000000",
    });
  });
}

indexer.onEvent({ contract: "PonsV2Factory", event: "TokenLaunchedV2" }, async ({ event, context }) => {
  saveLaunchToken(context, event.chainId, event.params.token);
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
});

indexer.onEvent({ contract: "UniswapV3Factory", event: "PoolCreated" }, async ({ event, context }) => {
  if (await isPonsToken(context, event.chainId, event.params.token0, event.params.token1)) {
    savePool(context, event.chainId, "uniswap_v3", event.params.pool, event.srcAddress, event, {
      currency0: event.params.token0, currency1: event.params.token1,
      fee: Number(event.params.fee), tickSpacing: Number(event.params.tickSpacing),
      hooks: "0x0000000000000000000000000000000000000000",
    });
  }
});

indexer.onEvent({ contract: "UniswapV2Factory", event: "PairCreated" }, async ({ event, context }) => {
  if (await isPonsToken(context, event.chainId, event.params.token0, event.params.token1)) {
    savePool(context, event.chainId, "uniswap_v2", event.params.pair, event.srcAddress, event, {
      currency0: event.params.token0, currency1: event.params.token1,
      fee: 3000, tickSpacing: 0,
      hooks: "0x0000000000000000000000000000000000000000",
    });
  }
});

indexer.onEvent({ contract: "UniswapV4PoolManager", event: "Initialize" }, async ({ event, context }) => {
  if (await isPonsToken(context, event.chainId, event.params.currency0, event.params.currency1)) {
    savePool(context, event.chainId, "uniswap_v4", event.params.id, event.srcAddress, event, {
      currency0: event.params.currency0, currency1: event.params.currency1,
      fee: Number(event.params.fee), tickSpacing: Number(event.params.tickSpacing), hooks: event.params.hooks,
    });
  }
});
