# Launchpad Aggregator — Research and Proposed Roadmap

**Date:** 28 September 2026  
**Status:** Research report, not a technical specification  
**Planning assumption:** One full-time developer; estimates are provisional, not delivery commitments.

## Objective and scope

Build a multi-chain launchpad aggregator that discovers historical and new token launches, identifies the originating launchpad, follows each token through its launch lifecycle, displays market activity, and eventually supports in-app buying and selling.

For an integrated launchpad, the target is **all of its launch-capable mainnet chains and relevant historical protocol versions**, not a manually selected subset of chains. Token creation is outside this project's scope. The first version will run locally, with zero application trading fee; infrastructure spending and any later fee policy will be decided separately.

## Research method and evidence levels

I reviewed platform/chain documentation and made read-only calls to live HTTP APIs, JSON-RPC endpoints, and WebSocket endpoints on 28 September 2026. The findings below distinguish three levels of evidence:

1. **Documented/deployed:** The platform lists a chain and its factory has bytecode there.
2. **Sample data retrieved:** Actual launch, trade, pool, or transfer records were returned.
3. **Complete history reconciled:** A full historical scan was matched against an independent total or source.

A deployed contract or a successful sample query alone does **not** prove complete historical coverage. No platform has yet passed the project's full end-to-end acceptance test, including historical coverage, realtime recovery, lifecycle metrics, and real trading.

## Platform and chain findings

| Platform | Documented launch-capable chains | Live test and evidence | Assessment |
| --- | --- | --- | --- |
| [Pons](https://docs.ponsfamily.com/) | Robinhood | Retrieved real v1 and v2 `TokenLaunched` logs. In one sampled million-block range, v2 returned 6,491 launches; real v2 curves emitted `CurveBuy` and `CurveSell` events. [V2 integration documentation](https://docs.ponsfamily.com/v2). | Strong first on-chain integration. Full-history backfill and post-graduation pool reconciliation remain to be built. |
| [full.fun](https://docs.full.fun/en/docs/setup) **(additional candidate)** | Robinhood, Arc, BNB Smart Chain | Its public API paginated on all three chains, and its published platform contracts had bytecode on all three. On Robinhood, the API reported 63 launches and an independent scan of `PoolCreated` logs also found **63**. Trades, candles, and holders endpoints responded; a realtime socket connected, but no live trade arrived during the test. [API reference](https://docs.full.fun/en/docs/api); [events](https://docs.full.fun/en/docs/events). | Best candidate for early multi-chain proof. Arc/BNB historical totals still require on-chain reconciliation. Its API holder metric is curve-based, not a complete ERC-20 holder list. |
| [Bow](https://bow.fun/docs.html) | Robinhood | Retrieved `Launched` logs from the current FactoryHub; on-chain `launchCount()` returned 196. Found launch-related logs from its separate legacy factory. | Promising next integration, but legacy event decoding and V3/V4 launch modes require a completeness audit. |
| [NOXA](https://docs.noxa.fi/contracts/noxa-fun/) | Robinhood, MegaETH, Monad, Intuition, Stable, Merlin, Arc | Verified factory bytecode on **all seven** documented chains. Retrieved launch logs on Robinhood, MegaETH, and Intuition. For one MegaETH launch, retrieved 20 official-pool `Swap` logs and 22 token `Transfer` logs. A public Intuition WebSocket accepted `eth_subscribe`. [Developer integration documentation](https://api-noxa.fun/). | Indexable in principle, but complete history across seven chains is not yet proven. Public RPC restrictions make an all-chain, free backfill risky. |
| [Bankr](https://docs.bankr.bot/token-launching/api-reference/deploy-token-launch/) | Base, Robinhood, Arbitrum, Arc* | The public launches endpoint returned 50 records even when queried with `limit=100` or `cursor=0`, consistent with its [documented 50-recent-launch limit](https://docs.bankr.bot/token-launching/api-reference/list-token-launches/). Its launch provider may differ per token, even on the same chain. | The public list cannot prove full historical coverage. Needs a separate provenance, provider-version, and on-chain audit. *Arc launch availability must be checked at runtime.* |
| [pools.xyz](https://support.uniswap.org/hc/en-us/articles/47943121516685-Launching-and-trading-tokens-on-pools-xyz) | Robinhood, Arc | Verified documented chain support and the distinct Instant Launch and Crowd Launch mechanisms. | Factory/event coverage and auction history are not yet verified. |
| [letscash.fun](https://www.letscash.fun/docs) | Robinhood | Reviewed its contract and launch-mode documentation; the publicly rendered page currently shows `n/a` for key contract addresses. | Requires verified contract addresses and a legacy-version audit. |
| [Long](https://longx.fun/) | Robinhood | Confirmed the platform's Robinhood positioning, but did not verify a complete historical launch source. | Technical discovery required. |
| [Varo](https://rialto.ghost.io/rialto-update-02-08-04/) | Robinhood | Confirmed a launch feed and Uniswap Launches integration, but did not verify a complete public factory/event source. | Technical discovery required. |

The documented union of chains for the **original eight** platforms is **nine**: Robinhood, Base, Arbitrum, Arc, MegaETH, Monad, Intuition, Stable, and Merlin. Adding full.fun would introduce **BNB Smart Chain** as a tenth. Documentation is not the same as verified live launch activity or complete data access.

### Important RPC and realtime test results

- On Robinhood, a single unbounded NOXA `eth_getLogs` query failed because it exceeded a 10,000-log limit. Smaller block chunks returned historical launches. The indexer therefore needs adaptive chunk sizes and saved checkpoints.
- The public RPCs tested limited `eth_getLogs` to approximately **100 blocks on Monad**, **1,024 on Stable**, and **2,000 on Merlin** per request. Stable also could not serve some older historical state. Arc's public RPC rate-limited a batch historical scan. These observations describe the tested public endpoints, not every commercial provider.
- NOXA's Intuition WebSocket returned a successful subscription ID. full.fun's Socket.IO endpoint completed a connection and subscription attempt, but no live trade was observed during the short test. Neither observation establishes a production latency or uptime guarantee.
- Robinhood's [official connection guidance](https://docs.robinhood.com/chain/connecting/) recommends an archive endpoint for historical reads and indexing and warns that its public RPC is rate-limited and not intended for production.

## Recommended rollout

**First choice:** Pons on Robinhood, followed by full.fun on **all three** of its mainnet chains—Robinhood, Arc, and BNB—if adding a platform outside the original list is approved. Pons gives a high-activity on-chain integration; full.fun provides a practical early test of multi-chain architecture and paginated API/on-chain reconciliation.

**If scope must remain within the original eight:** Replace full.fun with Bow on Robinhood for the second integration. Plan the first multi-chain expansion only after the NOXA provider and history audit. This route is closer to the original list but delays multi-chain proof.

Bow is the next candidate after the first two. NOXA should be added as one seven-chain platform integration only when historical access is viable for **all seven** chains. Bankr, pools.xyz, letscash.fun, Long, and Varo remain candidates; their order should be decided from verified data-source completeness, not website chain badges.

## Data and realtime strategy

Use platform APIs for fast initial listings and metadata where they are usable and paginated. Use factory events and chain state to establish launchpad provenance and audit completeness. Index bonding-curve trades or official-pool swaps into a durable event ledger; derive candles, price, rolling 24-hour volume, and rankings from that ledger. Track graduation so the token's **official** history remains continuous. Index additional pools separately, with pool-specific charts, trades, volume, and trade execution. Calculate true token holders from ERC-20 `Transfer` history or a verified holder index, rather than treating a platform-specific buyer list as all holders.

Use WebSocket subscriptions where reliable access exists, combined with HTTP `eth_getLogs` for historical backfill and gap repair after disconnects. Deduplicate events by chain ID, transaction hash, and log index; handle reorgs and expose sync coverage. Incomplete history must not appear as zero volume or a complete ranking. The feed's 24-hour volume should use the **official launch venue**; an additional pool page should display **that pool's** volume. Buyer attribution needs event-level or transaction-level validation because a DEX `Swap.sender` can be a router rather than the end user.

The first trading flow should execute on the **selected venue and chain**, with clearly separated simulated and real modes. A buy button is disabled with a reason when the wallet lacks the required quote asset or gas; it should not redirect users into funding. Cross-chain transfer is a later, independent feature. Application fees should be isolated in configuration/policy and remain zero for the local pilot.

## Provisional milestones and timeline

| Milestone | Deliverable and exit condition | Solo-developer estimate |
| --- | --- | ---: |
| 0. Source and provider audit | Registry of factories, versions, deployment blocks, APIs, chain support, RPC/WSS limits, and historical coverage for the original eight plus the proposed additional candidate. Decide provider requirements before promising all-chain completeness. | 2–4 weeks |
| 1. Core indexer and Pons | Reproducible historical/live v1 and v2 launch indexing; lifecycle, official trades and candles; checkpoints and reconciliation tests. | 4–6 weeks |
| 2. First multi-chain platform | full.fun read-only integration on Robinhood, Arc, and BNB with API/on-chain reconciliation. If full.fun is not approved, integrate Bow and revise the multi-chain milestone. | 3–5 weeks, conditional |
| 3. Product data UI | Feed, search and filters; launchpad provenance; token and selected-pool pages; official volume, charts, holders, risk signals, and visible sync status. | 4–6 weeks |
| 4. Trading | Simulated and real selected-venue buy/sell; quotes, approvals, gas/balance checks, transaction states, and tests; zero application fee. | 4–7 weeks |
| 5. Local pilot and hardening | Replay/reorg tests, provider fallback, performance tests, and data-quality checks. | 2–3 weeks |

Milestone 2 depends on adequate historical access for Arc and BNB. Under the full-time assumption, a **multi-chain data-pipeline demonstration** is tentatively **9–15 weeks**, a **read-only user-facing pilot** is **13–21 weeks**, and a tested **local pilot with real trading** is approximately **19–31 weeks**. These ranges must be revised after Milestone 0. A firm deadline for all original eight platforms is not defensible until their historical sources and provider requirements are audited.

## Decisions requested

1. Approve either **Pons + full.fun** for earlier multi-chain proof, or **Pons + Bow** to stay within the original platform list.
2. Confirm that “fully integrated” includes historical launches, legacy protocol versions, all launch-capable mainnet chains, realtime recovery, and selected-venue trading—not just displaying recent tokens.
3. Confirm whether an archive RPC or indexing-provider budget may be used if the free local audit shows it is necessary. The local prototype can start without paid infrastructure, but free public endpoints cannot presently support a credible completeness promise on every chain.

After these decisions, the next artifact is a **technical specification** for the approved first integration wave. This report is intentionally not that specification.
