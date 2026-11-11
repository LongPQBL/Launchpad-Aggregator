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

async function isPonsToken(context: TokenReader, chainId: number, a: string, b: string): Promise<boolean> {
  const [tokenA, tokenB] = await Promise.all([
    context.SeedLaunchToken.get(tokenId(chainId, a)),
    context.SeedLaunchToken.get(tokenId(chainId, b)),
  ]);
  return tokenA !== undefined || tokenB !== undefined;
}

function savePool(context: any, chainId: number, kind: string, address: string, sourceAddress: string, event: any,
  poolKey?: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): void {
  const normalized = address.toLowerCase();
  context.SeededPool.set({
    id: poolId(chainId, kind, normalized),
    chainId,
    kind,
    poolAddress: normalized,
    sourceAddress: sourceAddress.toLowerCase(),
    currency0: poolKey?.currency0.toLowerCase() ?? null,
    currency1: poolKey?.currency1.toLowerCase() ?? null,
    fee: poolKey?.fee ?? null,
    tickSpacing: poolKey?.tickSpacing ?? null,
    hooks: poolKey?.hooks.toLowerCase() ?? null,
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  });
}

function saveLaunchToken(context: any, chainId: number, token: string): void {
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
    savePool(context, event.chainId, "pons_v1", event.params.pool, event.srcAddress, event, {
      currency0: event.params.token, currency1: event.params.pairToken,
      fee: 0, tickSpacing: 0, hooks: "0x0000000000000000000000000000000000000000",
    });
  });
}

indexer.onEvent({ contract: "PonsV2Factory", event: "TokenLaunchedV2" }, async ({ event, context }) => {
  saveLaunchToken(context, event.chainId, event.params.token);
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
