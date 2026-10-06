# Launch Trading Design

**Approved scope:** real on-chain buy/sell/swap execution for a connected browser wallet, against exactly one known venue per page — the bonding curve or graduated pool on a launch detail page, or a specific pool on a pool detail page. No platform fee, no cross-pool routing, no 1-click/permit2 session approvals, no simulated/paper trading. Builds directly on the existing wallet-connect-only work (`docs/superpowers/specs/2026-10-02-browser-wallet-connection-design.md`, `fe/src/wallet/`) — this spec adds signing and transaction submission, which that spec explicitly excluded.

## Why this scope

CLAUDE.md's roadmap item 4 requires real trading to be researched and spec'd separately from the read-only launch product, covering wallet signing, routing, fees, slippage, failures, and security before any code — this is that spec. The user's standing preference: insufficient funds on the selected chain disables Buy without a deposit-prompt substitute; bridging stays a separate feature; simulated/test trading stays clearly separate from real execution (this feature is 100% real execution, nothing fake runs alongside it).

## Protocol research (verified, not guessed)

Real historical transactions were pulled from this app's own indexed `trades` table, fetched via `eth_getTransactionByHash` against the private `RH_HTTP_RPC_URL` (the public RPC and Blockscout both return Cloudflare 403 for scripted access — already known, see CLAUDE.md's 2026-09-30 entry), and decoded against recovered ABIs with `viem`, cross-validated against `tx.value` and known addresses.

- **Bonding curve (pre-graduation):** a direct contract call, no router. `buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable returns (uint256)` (selector `0x59a87bc1`); `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)` (selector `0xd04c6983`) pays out the quote asset.
  - **Correction (2026-10-06, verified by `eth_call` simulation against two real launches, not assumed from the one originally-decoded sample):** `buy`'s native-ETH-`value` behavior is per-launch, not universal. For a native-ETH-quoted launch (`quote_asset_address = 0x0000…0000`), `quoteAmountIn` equals `msg.value`, confirmed from the original decoded sample. For an ERC20-quoted launch (confirmed against a live `trading`-phase USDG-quoted launch), sending `value` reverts with a cleanly-decodable custom error `UnexpectedNativeValue()` — the contract instead expects `quoteAmountIn` to be pulled via ERC20 `transferFrom`, which needs a prior `approve()`. Since most launches are ERC20-quoted, not native-ETH (observed counts: ~144k WETH-quoted, thousands each for NVDA/TSLA/AAPL/SPCX/USDG/GME/SPY/GOOGL, vs. ~13k native-ETH), **Buy needs the same approval step as Sell whenever the launch's quote asset isn't native ETH** — approval is the common case, not an edge case, for Buy as well as Sell. The per-launch quote-asset address (already in `LaunchDetail.quoteAsset.address`) decides which path a given launch's Buy panel takes; `0x0000…0000` means native ETH (no approval), anything else means ERC20 (approval required).
  - Simulating a revert against a graduated (no-longer-`trading`) curve returned another clean custom error, `CurveGraduated()` — both decoded custom errors had `hasVerifiedContract: true` in openchain.xyz's signature database, i.e. recognized elsewhere, a good sign the contract uses a conventional custom-error pattern the plan can decode and surface as plain-language errors rather than a generic revert message.
- **Graduated V3 pool (V1 launches):** standard, publicly-documented Uniswap `SwapRouter02.exactInputSingle((tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96))` (selector `0x04e45aaf`). One observed router address (`0x9c0489b89ae473de6edcb159f21c3019ba730282`) — plausible bytecode size for SwapRouter02, not yet cross-checked against an authoritative Robinhood Chain deployment registry.
- **Graduated V4 pool (V2 launches):** V4's unlock/callback architecture has no plain direct swap entrypoint by design. Goes through Uniswap's standard Universal Router `execute(bytes commands, bytes[] inputs, uint256 deadline)` (selector `0x3593564c`). One observed address (`0x8876789976decbfcbbbe364623c63652db8c0904`), same caveat as above. The V4-specific command/action byte encoding inside `commands`/`inputs` was identified at the selector level only — full encoding is an implementation-plan task, not resolved here.
- **Plain pool swap (Pools tab, non-Pons-designated):** same SwapRouter02 (V3/V2-via-V3-router) or Universal Router (V4) call as above, scoped to that specific pool instead of the token's official venue.
- **Rejected as a dependency:** a "Swap Router" address docs.ponsfamily.com names (`0xCaf681a66D020601342297493863E78C959E5cb2`) appeared embedded inside observed calldata but was never seen called directly with a cleanly-decodable selector — lower confidence than the three paths above, and the same doc page asserted "no bonding curve," which is factually wrong for the V1/V2 product this app already indexes (likely describes a newer/different Pons product). Not used.
- **Confirmed irrelevant:** a large share of on-chain activity is Robinhood's own ERC-4337 smart-account users (`EntryPoint.handleOps`) and unrelated third-party trading bots (Axiom, and several unidentified aggregator selectors). This app's wallet integration uses Wagmi's plain EOA injected connectors (`fe/src/wallet/config.ts`), which call the contracts above directly and normally — no smart-account infrastructure needed.

**Still open, non-blocking:** cross-check the two observed router addresses against an authoritative source (Uniswap's own chain-deployment registry, or a reply from `contact@ponsfamily.com`) before hardcoding them into production config. Confirm whether the launched-token ERC20 has any transfer tax that would break `minOut` math (standard ERC20 assumed, not yet individually verified). Both are implementation-plan tasks, not spec blockers — the plan should treat router addresses as config, not inline constants, so a correction later is a config change, not a code change.

## Venue-to-action mapping

| Page | Venue state | Action label | Call |
|---|---|---|---|
| Launch detail | curve (pre-graduation) | Buy / Sell | direct curve `buy`/`sell` |
| Launch detail | graduated V3 pool | Swap | `SwapRouter02.exactInputSingle` |
| Launch detail | graduated V4 pool | Swap | `UniversalRouter.execute` (V4 swap command) |
| Pool detail (Pools tab) | any V2/V3/V4 pool | Swap | `SwapRouter02` or `UniversalRouter`, scoped to that pool |

"Buy/Sell" vs "Swap" is not just a label choice — it reflects the real difference in underlying call shape (direct mint-style curve call vs. router-mediated pool exchange), and matches Pons's own contract event names (`CurveBuy`/`CurveSell`).

## UI flow

- Launch detail page: the price/chart card gains a tab switcher driven by `detail.officialVenues`'s current venue kind (not a user toggle) — Buy/Sell while on-curve, Swap once graduated.
- Pool detail page: a Swap panel targeting that one pool, independent of whether it's the token's official venue.
- Each panel: amount input, a computed output quote (via `useSimulateContract` static-calling `buy`/`sell` themselves with `minTokensOut`/`minQuoteOut: 0` before any wallet prompt — both are `returns (uint256)`, confirmed callable this way by live `eth_call` testing during this spec's research; pool paths use the router's own quoter), a settings gear (Max slippage: Auto default + custom override; Swap deadline in minutes), and the action button.
- Auto slippage default differs by venue kind: a wider default on curve-phase trades (steep bonding-curve price impact — competitor research on pump.fun found single buys commonly moving price 10–15% on thin curves) than on a graduated pool (comparable to Uniswap's own Auto behavior). Exact default percentages are an implementation-plan detail, not fixed here.
- Buy button disabled (not hidden, not replaced with a deposit prompt) when the connected wallet can't cover the trade — for a native-ETH-quoted launch, that's the Robinhood Chain ETH balance; for an ERC20-quoted launch, that's the quote-asset token balance (and the wallet still needs ETH for gas either way). Matches the user's standing preference from CLAUDE.md.
- Settings explicitly NOT built in this phase: "Trade options" (no routing choice exists — each page targets exactly one known venue) and "1-click swaps" (needs a separate permit2/session-approval design).

## Approval flow

Needed whenever the token being spent isn't native ETH — that includes curve Sell (always: the launched token itself is never native ETH), curve Buy for any ERC20-quoted launch (the common case, not the exception — see the correction above), and pool Swap unless the input side happens to be native ETH.

- Before Buy (ERC20-quoted)/Sell/Swap, check current allowance (`allowance(owner, spender)`) against the target contract (curve itself for curve Buy/Sell, SwapRouter02/Universal Router for pool Swap — exact spender per router needs confirming in the plan, Universal Router typically uses Permit2 as an intermediate allowance target rather than being approved directly).
- If insufficient, show an **Approve** step first (exact amount, not infinite, by default), then the Buy/Sell/Swap step — two separate wallet prompts, standard pattern.
- A native-ETH-quoted launch's Buy skips approval entirely (sends `value` directly) — this is the one path that stays single-transaction.

## Error handling & transaction status

Distinct, plain-language messages per category — never a generic "transaction failed":
- Wallet rejected the request
- Insufficient funds (pre-empted by disabling Buy, but still handled if balance changes mid-flow)
- Slippage/minOut exceeded (on-chain revert)
- Approval still pending / not yet confirmed
- Generic RPC/network failure

After submission: pending → confirmed/failed, tracked via `useWaitForTransactionReceipt`, with a link to the Blockscout explorer once a tx hash exists (reuses the existing `chainExplorerBase` helper).

## Testing

Component tests mock Wagmi's `useSimulateContract`/`useWriteContract`/`useWaitForTransactionReceipt` hooks, the same pattern `fe/src/wallet/wallet-control.tsx`'s existing tests use for `useAccount`/`useConnect`. Every state above (quote loading, insufficient funds, approval needed, approval pending, trade pending, trade confirmed, trade failed by category, wrong chain) gets a test. No automated test requires a real wallet extension or spends real funds — matches the wallet-connection spec's existing verification approach.

## Explicitly out of scope

Platform fee or any monetization mechanism (deferred, a separate future decision), 1-click swaps / permit2 session approvals, a routing/trade-options choice UI (no routing exists — one venue per page), cross-pool price comparison or aggregation, bridging/cross-chain transfer (separate feature per CLAUDE.md), any simulated/paper-trading mode.

## References

- `docs/superpowers/specs/2026-10-02-browser-wallet-connection-design.md` — wallet connect-only, this spec's prerequisite
- `fe/src/wallet/` — existing Wagmi config and wallet control UI this builds on
- `be/src/launchpads/pons/v2/abi.ts`, `v1/abi.ts` — existing event ABIs (decoding only); this spec adds write-function ABIs
- Uniswap `SwapRouter02` and `Universal Router` — standard, publicly documented interfaces (not Robinhood-chain-specific)
