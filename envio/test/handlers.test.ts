import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

type Address = `0x${string}`;

const token: Address = "0x39dBed3a2Bd333467115de45665CC57F813c4571";
const deployer: Address = "0xB9f5F4eA1Af1F5D3678470Eb98E8Fbdcadeb24b0";
const dexFactory: Address = "0x1F7d7550B1b028f7571e69a784071f0205fD2efa";
const pairToken: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const pool: Address = "0x10cc6BD38112caC182Db90B6a71D8bB5939526bA";

const launchedSimulate = {
  contract: "PonsV1LegacyFactory" as const,
  event: "TokenLaunched" as const,
  params: {
    token, deployer, dexFactory, pairToken, pool,
    dexId: 0n, launchConfigId: 0n, positionId: 0n,
    restrictionsEndBlock: 0n, initialBuyAmount: 0n,
  },
};

describe("PonsV1LegacyFactory TokenLaunched", () => {
  it("stores a lowercase RawLaunch entity", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [launchedSimulate] } } });

    const launches = await indexer.RawLaunch.getAll();
    expect(launches).toHaveLength(1);
    expect(launches[0].tokenAddress).toBe(token.toLowerCase());
    expect(launches[0].deployerAddress).toBe(deployer.toLowerCase());
    expect(launches[0].pairTokenAddress).toBe(pairToken.toLowerCase());
    expect(launches[0].poolAddress).toBe(pool.toLowerCase());
  });

  it("registers the launch's pool for dynamic Swap indexing via contractRegister", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [launchedSimulate] } } });

    const registered = indexer.chains[4663].PonsV3Pool.addresses.map((address) => address.toLowerCase());
    expect(registered).toContain(pool.toLowerCase());
  });
});

describe("PonsV3Pool Swap", () => {
  it("stores a lowercase RawSwap entity with the transaction's from address, not the event's sender param", async () => {
    const indexer = createTestIndexer();
    // Register the pool first — PonsV3Pool has no static address in config.yaml (dynamic-only), so a
    // Swap from it only routes to a handler once contractRegister has added it, exactly like on chain.
    await indexer.process({ chains: { 4663: { simulate: [launchedSimulate] } } });

    const sender: Address = "0xCaf681a66D020601342297493863E78C959E5cb2"; // a router, not the trader
    const recipient: Address = "0xf89F3858Bc7bac05a83Ec284E3E9AcDb58BF892A";
    const txFrom: Address = "0xAAAA567890123456789012345678901234567890"; // the actual trader EOA

    await indexer.process({
      chains: {
        4663: {
          simulate: [{
            contract: "PonsV3Pool",
            event: "Swap",
            srcAddress: pool,
            transaction: { from: txFrom },
            params: {
              sender, recipient,
              amount0: 100_000_000_000_000_000n,
              amount1: -68057245261861571047346184n,
              sqrtPriceX96: 2005366647941715384651103712059394n,
              liquidity: 36819258015569838458222n,
              tick: 202790n,
            },
          }],
        },
      },
    });

    const swaps = await indexer.RawSwap.getAll();
    expect(swaps).toHaveLength(1);
    expect(swaps[0].poolAddress).toBe(pool.toLowerCase());
    expect(swaps[0].sender).toBe(sender.toLowerCase());
    expect(swaps[0].recipient).toBe(recipient.toLowerCase());
    expect(swaps[0].txFrom).toBe(txFrom.toLowerCase());
    expect(swaps[0].txFrom).not.toBe(swaps[0].sender);
  });
});
