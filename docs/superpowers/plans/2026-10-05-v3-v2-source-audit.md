# Robinhood Chain Uniswap V3/V2 source audit (2026-10-05)

Task 6 source evidence, separate from the Pons V1/V2 launch protocol versions.

| Source | Factory | Deployment block | Deployment transaction | Factory event | Pool event |
| --- | --- | ---: | --- | --- | --- |
| Uniswap V3 | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | 8930 | `0x8add72fbcad4bf7732336de35dcd06b582c1501d0832c4710a30850a7cff8977` | `PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)` | `Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)` |
| Uniswap V2 | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` | 8928 | `0x2fc08b6c72d5f2120cec9f3be8ed0b45c210d51adbc87f33b2135886681edaf7` | `PairCreated(address indexed token0,address indexed token1,address pair,uint256)` | `Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)` and `Sync(uint112 reserve0,uint112 reserve1)` |

Uniswap's [Robinhood V3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments), [V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments), and [chain 4663 deployment ledger](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) identify the factories and transactions. The deployment blocks were read from `eth_getTransactionReceipt` against `https://rpc.mainnet.chain.robinhood.com` and matched the expected `contractAddress`, with successful status. Event selectors were derived from the ABI signatures and checked against read-only `eth_getLogs` responses.

Bounded samples from the public RPC (chain 4663):

- V3 `PoolCreated` selector `0x783cca1c0412dd0d695e784568c96da2e8b1d9b2b4e6b7118`; range 80,617,437–80,627,436 returned one event. Block 80,621,619, transaction `0x23328bc26985894a120fff1e27f9b24a7659e9fb91d461ec41159528ec2f2ff5`, pool `0x33ff8af61bc6b026636026fccd03d44a743f8f8c`. Its `Swap` selector `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` returned 599 logs in range 80,619,362–80,629,362; first at block 80,621,619, log 21, same transaction.
- V2 `PairCreated` selector `0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9`; range 80,617,437–80,627,436 returned 42 events. First at block 80,617,845, transaction `0x8101c9fd793cfa59a4eba7c237d2126624da0007cbe0b8f18bb38551c9ab73db`. Pair `0x5378b354324d38054a004cc4f79cb355d2b17850` from a later event in the same range had 64 `Swap` logs through block 80,629,362. First sampled swap: block 80,623,998, transaction `0xe5409093cf9b4b0b1f6d76c7110f620caefd7cc4442132fd32ac8ef0ad8a6a64`, log 4. Swap selector `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`.

This is a bounded source sample, not full Envio-to-chain parity. V3/V2 remain unsupported in the public Pools API until Envio indexes their histories and a full bounded-page parity audit is complete. The public RPC does not provide arbitrary historical `eth_getCode` state; the deployment transaction receipts provide the exact starting blocks.
