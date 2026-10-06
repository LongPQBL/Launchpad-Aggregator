# Launch Trading Design

**Approved scope:** real on-chain buy/sell/swap execution for a connected browser wallet, against exactly one known venue per page — the bonding curve or graduated pool on a launch detail page, or a specific pool on a pool detail page. No platform fee, no cross-pool routing, no 1-click/permit2 session approvals, no simulated/paper trading. Builds directly on the existing wallet-connect-only work (`docs/superpowers/specs/2026-10-02-browser-wallet-connection-design.md`, `fe/src/wallet/`) — this spec adds signing and transaction submission, which that spec explicitly excluded.

## Why this scope

CLAUDE.md's roadmap item 4 requires real trading to be researched and spec'd separately from the read-only launch product, covering wallet signing, routing, fees, slippage, failures, and security before any code — this is that spec. The user's standing preference: insufficient funds on the selected chain disables Buy without a deposit-prompt substitute; bridging stays a separate feature; simulated/test trading stays clearly separate from real execution (this feature is 100% real execution, nothing fake runs alongside it).

## Protocol research (verified, not guessed)

Real historical transactions were pulled from this app's own indexed `trades` table, fetched via `eth_getTransactionByHash` against the private `RH_HTTP_RPC_URL` (the public RPC and Blockscout both return Cloudflare 403 for scripted access — already known, see CLAUDE.md's 2026-09-30 entry), and decoded against recovered ABIs with `viem`, cross-validated against `tx.value` and known addresses.

- **Bonding curve (pre-graduation):** a direct contract call, no router. `buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable` (selector `0x59a87bc1`) — `quoteAmountIn` equals `msg.value` in every decoded sample, confirming native ETH is the buy input regardless of the launch's nominal quote-asset symbol. `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)` (selector `0xd04c6983`) pays out the quote asset and requires a standard ERC20 `approve()` on the launched token first.
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
- Each panel: amount input, a computed output quote (via `useSimulateContract`/a read-only `eth_call` quote path before any wallet prompt — curve uses its own pricing view, pool paths use the router's quoter), a settings gear (Max slippage: Auto default + custom override; Swap deadline in minutes), and the action button.
- Auto slippage default differs by venue kind: a wider default on curve-phase trades (steep bonding-curve price impact — competitor research on pump.fun found single buys commonly moving price 10–15% on thin curves) than on a graduated pool (comparable to Uniswap's own Auto behavior). Exact default percentages are an implementation-plan detail, not fixed here.
- Buy button disabled (not hidden, not replaced with a deposit prompt) when the connected wallet's Robinhood Chain balance can't cover the trade — matches the user's standing preference from CLAUDE.md.
- Settings explicitly NOT built in this phase: "Trade options" (no routing choice exists — each page targets exactly one known venue) and "1-click swaps" (needs a separate permit2/session-approval design).

## Approval flow

Only needed for Sell (curve) or Swap where the input token isn't native ETH. Buy on the curve never needs approval (native ETH, `payable`).

- Before Sell/Swap, check current allowance (`allowance(owner, spender)`) against the target contract (curve for Sell, SwapRouter02/Universal Router for pool Swap — exact spender per router needs confirming in the plan, Universal Router typically uses Permit2 as an intermediate allowance target rather than being approved directly).
- If insufficient, show an **Approve** step first (exact amount, not infinite, by default), then the Sell/Swap step — two separate wallet prompts, standard pattern.

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
