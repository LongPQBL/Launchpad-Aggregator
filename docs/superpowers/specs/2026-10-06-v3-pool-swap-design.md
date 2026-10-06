# V3 Pool Swap Design

**Approved scope:** real on-chain Swap execution for a connected browser wallet, against a Uniswap V3 pool — either a V1 launch's graduated official venue (launch detail page) or any V3 pool on the Pools-tab page. No platform fee, no cross-pool routing, no 1-click/permit2 session approvals, no simulated/paper trading, same ground rules as curve trading. Follow-up to `docs/superpowers/specs/2026-10-06-launch-trading-design.md` (curve Buy/Sell), which this spec extends — V4 pool swap (Universal Router command encoding) is a separate, later follow-up, not in scope here.

## Why this scope, and why V3 before V4

CLAUDE.md's roadmap item 4 requires real trading to be researched and spec'd before code, same as the curve phase. V3 and V4 are the two pool generations this app already indexes (V1 Pons launches graduate to V3, V2 Pons launches graduate to V4 after sweeping their curve) — V3's swap interface is a single well-documented function call; V4's shared-`PoolManager` architecture requires decoding Universal Router's custom command/action byte encoding, a materially larger research and implementation task. Splitting them avoids blocking the simpler, already-substantially-verified V3 path on that larger V4 research effort.

## Protocol research (verified, not guessed)

The public RPC (`https://rpc.mainnet.chain.robinhood.com`) was reachable without a Cloudflare block during this research (the private `RH_HTTP_RPC_URL` configured in `be/.env` returned `"api client is disabled"` — a subscription/quota state, not investigated further; use the public RPC for this plan's implementation work and re-check the private one before relying on it). Real historical V3-pool transactions were pulled from this app's own indexed `trades` table (scoped to `v3_pool` venues on `protocol_version = 'v1'` launches), fetched via `eth_getTransactionByHash`, and decoded against recovered ABIs with `viem`.

- **The router:** `0xcaf681a66d020601342297493863e78c959e5cb2`. This is the exact address `docs.ponsfamily.com` names as "Swap Router" — the earlier curve-trading spec's research saw this address embedded inside other calldata but never called directly with a decodable selector, and explicitly deprioritized it on that basis. This research found a real transaction calling it *directly*: selector `0x5ae401dc` = `multicall(uint256 deadline, bytes[] data)` (a standard, publicly-documented Uniswap `SwapRouter02` function), whose single inner call fully decodes as `exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))` (selector `0x04e45aaf`) — real example: `tokenOut = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (matches this chain's known WETH/quote-token address from prior research), `fee = 10000` (1% tier), `sqrtPriceLimitX96 = 0` (no limit). This reverses the earlier spec's deprioritization: the address is real, standard, and matches Pons's own documentation.
  - **The call shape that matters for implementation:** a V3 swap is not a bare `exactInputSingle` call — it's `multicall(deadline, [exactInputSingleCalldata])`. The `deadline` parameter genuinely exists and is consumed here (unlike the curve phase, which had no deadline parameter anywhere — this is why the curve-trading plan hid the Swap-deadline settings control for `venueKind: 'curve'`; for V3 pool swaps, that same control now has somewhere real to go).
- **Real traffic is mostly NOT this router.** Of 15 sampled real V3-pool transactions, only 1 called this standard router directly. The other 14 split across two different contracts (`0xccc88a9d1b4ed6b0eaba998850414b24f1c315be`, selector `0x0a2b8f36` = `permit2TransferAndMulticall(...)`; and `0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc`, selector `0x4d819a2a` = `swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256)`, several with non-zero `value`) — neither matches a standard, publicly-documented Uniswap interface; both have the shape of third-party aggregator/bot contracts (consistent with the curve-trading spec's own finding that "a large share of on-chain activity is...unrelated third-party trading bots"). **Rejected as a dependency**, same reasoning as the curve spec applied to Robinhood's own smart-account traffic: higher real-world call volume from bots doesn't make an undocumented, unverified interface the right one to build a legitimate read-and-trade app against, when a standard, documented, directly-confirmed alternative exists.
- **Native ETH behavior: assumed standard, not independently confirmed on this deployment.** None of the 15 samples sent `value` through the confirmed router (`0xcaf...`). Uniswap's canonical `SwapRouter02` source wraps ETH automatically inside `exactInputSingle`/`exactOutputSingle` when `tokenIn == WETH9` and the router already holds sufficient `msg.value` balance (via its own `PeripheryPayments.pay()` helper) — this is a property of the standard contract's own code, not something that varies per chain deployment, and the router's bytecode at this address contains the `exactInputSingle` selector (confirmed via `eth_getCode` substring match, 23,536 bytes — a plausible size for `SwapRouter02`). Treat ETH-in as working via `multicall(deadline, [exactInputSingle(tokenIn: WETH, ...)])` sent with `value: amountIn`, consistent with standard SwapRouter02 usage, but flag this as **assumed from the standard contract's well-documented behavior, not verified by a real on-chain sample on this specific deployment** — the implementation plan should do one `eth_call` simulation with real `value` before relying on it, the same evidence-gate this project applied to the curve's native-ETH-vs-ERC20 distinction.
- **Generalizes to the Pools-tab case without further research.** `SwapRouter02`'s pool selection is derived entirely from `(tokenIn, tokenOut, fee)` in the call, not hardcoded per integration — the same router and call shape apply to any V3 pool on this chain, not just V1-launch official venues. No separate verification needed for the Pools-tab Swap panel beyond what's documented here.

**Still open, non-blocking** (same treatment as the curve spec's open items): confirm whether any Pons-launched token has a transfer tax that would break `amountOutMinimum` math (standard ERC20 assumed, not individually verified); the private `RH_HTTP_RPC_URL`'s `"api client is disabled"` state should be resolved or replaced before production (the public RPC worked for this research but CLAUDE.md's 2026-09-30 entry documents it intermittently 403'ing under load — don't assume it stays reliable).

## Venue-to-action mapping (supersedes the curve spec's V3 row for this phase)

| Page | Venue state | Action label | Call |
|---|---|---|---|
| Launch detail | graduated V3 pool (V1 launches) | Swap | `0xcaf681a66d020601342297493863e78c959e5cb2`'s `multicall(deadline, [exactInputSingle(...)])` |
| Pool detail (Pools tab) | any V3 pool | Swap | same router/call, scoped to that pool's `(tokenIn, tokenOut, fee)` |

V4 pool venues (V2 launches) and the V4-protocol Pools-tab case remain out of scope — the curve-trading spec's existing gating (`fe/src/features/launch/launch-detail.tsx`'s `activeCurveVenue` check) already means nothing renders for a V2 launch once it graduates; this phase does not change that, it only adds a path for `v3_pool` venue kind.

## UI flow

- Reuses the existing trading module's shared pieces unchanged: `fe/src/trading/use-trade-settings.ts` (slippage + deadline — the deadline control becomes meaningful here, pass `venueKind="pool"` so `TradeSettingsPopover` shows it, per the curve plan's existing `venueKind`-gated hide/show), `fe/src/trading/use-trade-submission.ts`, `fe/src/trading/trade-status.tsx`, `fe/src/trading/decodeTradeError.ts`, `fe/src/trading/use-token-allowance.ts` (the router needs the same ERC20 `approve()` pattern as the curve's Sell/ERC20-Buy paths — exact-amount, never infinite, same as before).
- New pieces, mirroring the curve module's own shape:
  - `fe/src/trading/swapRouterAbi.ts` — `multicall` and `exactInputSingle` (the confirmed real shapes above).
  - `fe/src/trading/use-swap-quote.ts` — parallel to `use-curve-quote.ts`: a read-only `useSimulateContract` call against `exactInputSingle` (which itself `returns (uint256 amountOut)`, so the same static-call-for-a-quote pattern applies) with `amountOutMinimum: 0` for the quote read only (never for the real submitted call).
  - `fe/src/trading/swap-panel.tsx` — single "Swap" action (not Buy/Sell — matches the already-approved spec choice that direction is arbitrary in a pool), amount input, token-pair display (which side is "in" vs "out" — for the launch-detail case this is fixed by context, same as Buy/Sell were; for the Pools-tab case the panel needs a direction toggle, since neither side is privileged the way the launch's own token was for Buy/Sell).
- Quote-unavailable, insufficient-balance, wrong-chain, double-submit-guard, and scientific-notation-input handling all carry over unchanged from the curve-trading fixes already shipped (`fe/src/trading/buy-panel.tsx`/`sell-panel.tsx` are the reference implementation for all of these; the plan should extract shared logic where it's now duplicated three ways rather than copy-pasting a fourth time — revisit the curve module's internal structure for an extraction opportunity before writing `swap-panel.tsx`, this is an implementation-plan-level call, not fixed here).
- Auto slippage default: a V3 pool is not the curve's steep bonding-curve case — use the "graduated pool" default already defined in `resolveAutoSlippageBps('pool')` (`fe/src/trading/use-trade-settings.ts`, already implemented, unused until now).

## Approval flow

Same ERC20 exact-amount approve-then-call pattern as the curve's ERC20 paths — `useTokenAllowance(tokenIn, routerAddress)`. No native-ETH-only skip-approval case is assumed here the way curve Buy had one for native-ETH-quoted launches — the plan should confirm via the "still open" native-ETH research item above before deciding whether a native-ETH-in Swap skips approval the same way.

## Error handling & transaction status

Unchanged from the curve module: `decodeTradeError`'s pattern (known custom errors get a tailored message, everything else falls back to the real on-chain revert/error name rather than a flat "transaction failed") carries over directly. No new custom errors are confirmed for `SwapRouter02` in this research — if the implementation plan decodes a real revert during testing, add it the same way `CurveGraduated`/`UnexpectedNativeValue` were added, not before (don't invent error names).

## Testing

Same conventions as the curve module: wagmi fully mocked, no real wallet/funds, every state (quote loading/unavailable, approval needed/pending/confirming/reverted, insufficient balance, wrong chain, double-submit guard, scientific-notation input) gets a test, mirroring the exact test matrix `buy-panel.test.tsx`/`sell-panel.test.tsx` already established.

## Explicitly out of scope

V4 pool swap (separate future plan), platform fee, 1-click swaps/permit2 session approvals, cross-pool price comparison/routing, bridging, simulated/paper trading — unchanged from the curve spec's list.

## References

- `docs/superpowers/specs/2026-10-06-launch-trading-design.md` — curve Buy/Sell, this spec's prerequisite; most of `fe/src/trading/` is shared infrastructure
- `docs/superpowers/plans/2026-10-06-curve-trading.md` — the implementation plan whose shared pieces this phase reuses, and whose task-sizing/TDD/fix-loop conventions this phase's plan should follow
- Uniswap `SwapRouter02` — standard, publicly documented interface (not Robinhood-chain-specific)
