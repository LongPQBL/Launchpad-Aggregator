# V3 Pool Swap: Migrate to Universal Router + Permit2

**Approved scope:** migrate the already-shipped V3 `SwapPanel` (`fe/src/trading/swap-panel.tsx`, real on-chain V3 swap execution for a connected browser wallet — either a V1 launch's graduated official venue or any V3 pool on the Pools-tab page) from direct `SwapRouter02` calls to the same Universal Router + Permit2 architecture the V4 swap panel already uses. Bundled into this same migration, by explicit user decision after discussing the tradeoff: add native-ETH support (pay with ETH or WETH on whichever side of the pool is WETH, in either swap direction), which V3 never had even before this migration. No platform fee, no cross-pool routing, no multi-hop, no 1-click/EIP-5792 bundling (that remains a separate, later follow-up — see CLAUDE.md's roadmap note), no simulated/paper trading — same ground rules as every other trading spec in this project.

## Why this migration, and why now

Recorded in CLAUDE.md after the V4 pool swap shipped: Uniswap's own real production interface no longer prefers `SwapRouter02` as V3's entrypoint either — it also routes V3 through Universal Router + Permit2. The existing V3 implementation isn't wrong (independently verified on this exact chain via a decoded real transaction, and corroborated by `docs.ponsfamily.com` naming that router address) — it's architecturally older-style, and having two different approve/sign architectures side by side (V3 plain-approve, V4 Permit2) is extra surface area to maintain for no benefit once V3's own blocker is resolved. It also unblocks building EIP-5792 1-click swap bundling once, for both V3 and V4 together, instead of building it for V4 alone now and redoing it for V3 later.

## The blocker this spec resolves, and how

Migrating V3's *approval* architecture to Permit2 breaks V3's *quoting*, which today works by simulating a real `SwapRouter02.exactInputSingle` call as the connected account (`fe/src/trading/use-swap-quote.ts`) — this only succeeds because the user has directly approved `SwapRouter02`. Under Permit2, the user approves Permit2, never `SwapRouter02` directly, so that simulation would revert with `STF` (safeTransferFrom failed) permanently, not just before the user's first approval the way it does today.

V4 solved the equivalent problem (`UniversalRouter.execute()` has no return value, so simulating the real call can't produce a quote at all) with a dedicated on-chain `Quoter`-family contract, already deployed on this chain. This spec's research found and independently verified the real V3 equivalent is **also already deployed** — no new contract needed, same as V4:

- **`V3_QUOTER_ADDRESS = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`** — a real, standard Uniswap `QuoterV2`. Function: `quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)` — the real, standard Uniswap `QuoterV2` interface, not a project-specific or mixed-route variant. `nonpayable`, not `view` (same revert-based quoting mechanism as `V4_QUOTER_ADDRESS`), called via `eth_call`/`useSimulateContract`.
- Independently verified with two live `eth_call`s against the project's own real fixture pool (`be/tests/fixtures/pons-v1-reference.json`'s pool `0x10cc6bd38112cac182db90b6a71d8bb5939526ba`, `token0 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` — this chain's known WETH address, already used elsewhere in `be/src/launchpads/pons/v1/adapter.ts` — `token1 = 0x39dBED3a2bd333467115dE45665cC57F813C4571`, `fee = 10000`):
  - `1e18` of `token0` in → `amountOut = 6,379,288,314,693,126,190,146` (`token1` units), `gasEstimate = 96,633`.
  - `1e15` of `token1` in → `amountOut = 153,542,311,135` (`token0` units), `gasEstimate = 86,647`.
  - Both numbers (including the exact gas estimates) were independently re-derived from a second, separate live call and matched exactly — not taken on trust from a single source.
- This corrects an unverified assumption from the V4 spec: that spec's quoter (`0x7edd862aa08dD5Be664C21188E1A2A0E64e3A283`) was labeled `MixedRouteQuoterV2` only by inference ("the same pattern of account that would also carry quoting infrastructure"), never independently confirmed to cover V3. This spec's research tried three plausible V3-quoting signatures against that address (a guessed `quoteExactInputSingleV3` struct variant, the real standard `QuoterV2.quoteExactInputSingle` signature, and the packed-path `quoteExactInput(bytes,uint256)` mixed-route variant) — all three produced an empty `"0x"` revert, the signature of an unmatched selector with no fallback. That contract is V4-only; the `MixedRouteQuoterV2` label for it should be treated as unconfirmed going forward.

**Execution command.** No organic Universal-Router V3 swap transaction exists on this chain to decode (of 40 sampled recent real swaps on the sample pool above, zero went through Universal Router — consistent with the earlier V3 spec's finding that real V3 traffic mostly bypasses even the standard router). The command byte and encoding therefore come from Uniswap's documented `Commands.sol`/`V3SwapRouter.sol` — the same trust level this codebase already extends to `PERMIT2_PERMIT = 0x0a` and `V4_SWAP = 0x10` — plus new, real `eth_call` verification done for this spec (not organic-transaction verification, but not blind trust either):

- `V3_SWAP_EXACT_IN = 0x00`. Confirmed dispatching into real V3-specific router logic: a probe `eth_call` (state-overridden `from` balance, `UniversalRouter.execute()` with commands `[WRAP_ETH, V3_SWAP_EXACT_IN]`) reverted with selector `0x3b99b53d`, looked up via a public 4-byte signature database as `SliceOutOfBounds()` — a real error from Uniswap's own `Path.sol`/`BytesLib`, not a generic "unmatched function" or `InvalidCommandType` revert. This proves the command byte is right and the call reached real path-decoding logic; it does **not** prove this spec's exact input-tuple field order/shape is right (the probe's one attempt at `(recipient, amountIn, amountOutMinimum, path, payerIsUser)` hit a slicing error, meaning something about that shape is off). **Open item, not blocking spec approval** — the implementation plan's first task must iterate on this with one or more further bounded `eth_call`s against a real pool, informed by `V3SwapRouter.sol`'s actual declared parameter order, before relying on this encoding for a real submitted transaction. Same treatment the V4 spec gave its own action encoding.
- `WRAP_ETH = 0x0b`, `UNWRAP_WETH = 0x0c`. Both independently confirmed: `WRAP_ETH` alone (real `value`, state-overridden balance, recipient = `MSG_SENDER` sentinel `0x...0001`) succeeded cleanly. `UNWRAP_WETH` alone (zero amount) succeeded cleanly. A deliberately-invalid command byte (`0x1f`) correctly reverted with selector `0xd76a1e9e` plus the invalid byte as appended data — matching the documented `InvalidCommandType(uint256)` shape — confirming the dispatcher genuinely discriminates by command byte rather than succeeding unconditionally, which gives the `WRAP_ETH`/`UNWRAP_WETH` positive results real weight.
- Sentinel recipient constants `MSG_SENDER = 0x0000000000000000000000000000000000000001` and `ADDRESS_THIS = 0x0000000000000000000000000000000000000002` — Uniswap's documented `Constants.sol` values, used successfully in the probes above.

## Venue-to-action mapping (unchanged from the existing V3 spec — only the call shape changes)

| Page | Venue state | Action label | Call |
|---|---|---|---|
| Launch detail | graduated V3 pool (V1 launches) | Swap | `UniversalRouter.execute(...)` carrying `V3_SWAP_EXACT_IN` (+ `PERMIT2_PERMIT` when needed, + `WRAP_ETH`/`UNWRAP_WETH` when the user opts into native ETH) |
| Pool detail (Pools tab) | any V3 pool | Swap | same, scoped to that pool's `(tokenIn, tokenOut, fee)` |

## Approval flow — identical shape to V4, no new design

One-time `ERC20 → Permit2` approval (`maxUint256`, not exact-amount — same already-reviewed reasoning in the V4 spec: the real per-trade authorization is the separate, amount-and-expiration-scoped Permit2 `AllowanceTransfer`, which the standing ERC20 allowance alone cannot move funds under), then a `PermitSingle` EIP-712 signature per trade when the existing Permit2 allowance is insufficient or expired (nonce refetched fresh immediately before each signature — reuses `usePermit2Permit` unchanged, including its already-fixed stale-nonce and unhandled-rejection bugs). **Native-ETH-in skips this entirely** — no ERC20 involved on that side, nothing to approve or sign, same as V4's native-ETH case.

## Quoting

New `fe/src/trading/use-v3-swap-quote.ts`, parallel to `use-v4-swap-quote.ts`: a `useSimulateContract` call against `V3_QUOTER_ADDRESS`'s `quoteExactInputSingle`, fully decoupled from approval state (unlike today — no more pre-approval `STF`/manual-refetch dance; `useRefetchQuoteAfterApproval` becomes unnecessary for this panel, same as it's unused by the V4 panel).

## Execution

`UniversalRouter.execute(commands, inputs, deadline)`:
- Plain ERC20-in, ERC20-out: commands = `[PERMIT2_PERMIT?, V3_SWAP_EXACT_IN]` (identical shape to the V4 panel's command-building pattern).
- Native-ETH-in (user opted in): commands = `[WRAP_ETH, V3_SWAP_EXACT_IN]`, `WRAP_ETH` recipient = `ADDRESS_THIS` (wrap into the router's own balance), `V3_SWAP_EXACT_IN`'s `payerIsUser = false` (pay from the router's just-wrapped balance, not pull via Permit2), `value: amountIn` on the top-level call, no `PERMIT2_PERMIT` command (nothing to approve).
- Native-ETH-out (user opted in): commands = `[PERMIT2_PERMIT?, V3_SWAP_EXACT_IN, UNWRAP_WETH]`, `V3_SWAP_EXACT_IN`'s own recipient = `ADDRESS_THIS` (keep the output WETH in the router), `UNWRAP_WETH` recipient = `MSG_SENDER` (deliver native ETH to the user), `amountMin` on the unwrap = the same `amountOutMinimum` already computed for the swap.
- Native-ETH on one leg can combine with Permit2 on the other (e.g., pay with WETH via Permit2, receive native ETH). Native-ETH on both legs at once is not possible in a single 2-token pool — WETH can only be on one side at a time, so the other side is never WETH's own ambiguity in the first place.

Swap output always settles to the connected wallet's own address — same convention every other panel already uses.

## Native-ETH in/out: a token-selector control, not a port of V4's logic

**This is not a reuse of V4's native-ETH handling — it's a different problem with a different solution**, because V3 pools can only ever hold the real WETH ERC20 (V3 has no protocol-level "this pool natively settles in ETH" concept the way V4 does). V4's panel never asks the user anything because the *pool itself* fixes which single form (native ETH or a specific ERC20) is valid for a given side — there is no ambiguity to resolve. A V3 pool's WETH side, by contrast, can legitimately be funded from *either* of two real, independently-held wallet balances (native ETH or already-wrapped WETH), and the router transparently wraps/unwraps either way — so the UI has to ask which balance the user means.

**UI, per user-provided reference screenshots of Uniswap's own real "Select a token" pattern:** **both** sides of the panel always show the same pill-shaped button — `TokenLogo` (already built, already renders the exact circular-logo + bottom-right chain-badge look in the reference) plus the symbol and a chevron — for visual consistency with Uniswap's own app, regardless of how many real choices exist for that side. Clicking it opens a small selection surface listing only the tokens actually valid for that side of *this specific pool* (per the user's explicit scope: "chọn được token nào đang hỗ trợ cho pool đấy thôi" — not a free-form, searchable, any-token picker; no search box, no arbitrary cross-pool token list). Concretely: a pool's WETH leg lists two entries (ETH, WETH); every other side — the pool's other fixed token, e.g. a Pons-launched token, or a non-WETH quote asset like USDG — still gets the same button-and-dropdown chrome, just with exactly one entry in the list (that one token), matching the user's own worked example: "pool Token/USDG thì vẫn hiện nút chọn nhưng hiện ra bảng chứa 1 option là USDG thôi." A single-entry dropdown is not a dead end to design around — it's the normal case; the WETH leg's two-entry case is the exception.

Implementation should follow the existing hand-rolled dropdown pattern already in this module (`trade-settings-popover.tsx`'s `open` state + absolutely-positioned panel), not introduce a new shadcn `Dialog`/`Popover` primitive — this repo has neither yet, and a non-searchable list of at most two items doesn't need one. The existing ⇅ direction-flip button is unchanged and keeps its current job (choosing which side is being sold vs. bought); the new token-selector only disambiguates ETH vs. WETH on whichever side currently holds the WETH leg (every other side's dropdown is functionally inert — one entry, selecting it is a no-op), layered on top of that, not replacing it.

**Design:** compute `wethSide: 'A' | 'B' | null = tokenA.address === WETH_ADDRESS ? 'A' : tokenB.address === WETH_ADDRESS ? 'B' : null` once, independent of the existing `direction` (aToB/bToA) state. The token-selector always renders on both sides. Its options list is `[ETH, WETH]` when that side matches `wethSide`, defaulting to native ETH (matching Uniswap's own default), governed by a single `useNativeEth` boolean that persists across a `direction` flip (flipping only changes whether the WETH leg is currently "in" or "out", never which side it's on); otherwise its options list is just that side's one fixed token, and `useNativeEth` is irrelevant there. When `wethSide === null` (most Pools-tab pairs, e.g. two tokenized-stock quote assets with no WETH leg at all), both sides render the selector chrome with a single-entry list each, and swap behavior is identical to a plain ERC20 pair today.

Balance/approval/submission branch on `useNativeEth && tokenIn.address === WETH_ADDRESS` (native-ETH-in: `useBalance` instead of `balanceOf`, no approval, `value` sent) and separately on `useNativeEth && tokenOut.address === WETH_ADDRESS` (native-ETH-out: append `UNWRAP_WETH`, no change to balance/approval logic since the *payment* side is unaffected).

`WETH_ADDRESS = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` needs a new FE-side constant (currently only defined BE-side in `be/src/launchpads/pons/v1/adapter.ts` and two CLI scripts) — add it alongside the new `v3QuoterAbi.ts`/path-encoding module, not duplicated per-file.

## Components and reuse

- **Reused as-is, no changes:** `ApproveOrActionButton`, `useRefetchQuoteAfterApproval` (unused by this panel, same as V4), `use-trade-settings.ts` (`venueKind: 'pool'`), `trade-settings-popover.tsx`, `amount.ts`, `decodeTradeError.ts`, `usePermit2Permit`, `useTokenAllowance` (called with `spender = PERMIT2_ADDRESS`, `approve(maxUint256)`), `universalRouterAbi.ts`, `permit2Abi.ts`, `useTradeSubmission`, `TradeStatus`.
- **New:** `v3QuoterAbi.ts` (`V3_QUOTER_ADDRESS` + the `quoteExactInputSingle` signature above), `use-v3-swap-quote.ts`, a V3 path-packing helper (new `v3SwapEncoding.ts`, or extend `v4SwapEncoding.ts` if the project prefers one shared file — implementation plan's call), a `WETH_ADDRESS` constant, a new token-selector component (button + dropdown, reusing `TokenLogo`).
- **Restructured:** `swap-panel.tsx` — rebuilt to match `v4-swap-panel.tsx`'s shape (Permit2 signing hook usage, `execute()` submission, same `submitSwap` structure), plus the new token-selector neither existing panel has.
- **Deleted:** `swapRouterAbi.ts`, `use-swap-quote.ts` (confirmed via `grep` to have no other consumers in the codebase), and their matching test files. `usePoolFee`/`v3PoolAbi.ts` are unaffected (unrelated — pool fee tier reads, not swap execution) and stay.

## Error handling & transaction status

Unchanged pattern: `decodeTradeError` gets any new real custom errors this phase's testing surfaces (e.g. if the `SliceOutOfBounds`-adjacent open item above turns out to matter for a real user-facing revert path) added the same way `CurveGraduated`/`UnexpectedNativeValue` were — not invented ahead of time.

## Testing

Same conventions as every other trading panel: wagmi fully mocked, no real wallet/funds. Full existing V4-panel-equivalent matrix (quote loading/unavailable, Permit2 signature needed/pending/rejected/stale-nonce-refetch, insufficient balance, wrong chain, double-submit guard, scientific-notation input) plus new cases specific to this panel: the token-selector rendering on both sides regardless of WETH presence, a non-WETH side's dropdown listing exactly one entry and being a no-op to interact with, the WETH leg's dropdown listing exactly two entries, the selected `useNativeEth` choice surviving a direction flip, native-ETH-in balance/value-sending path, native-ETH-out `UNWRAP_WETH` command inclusion, and a pool with no WETH leg at all behaving as plain ERC20-ERC20 despite both sides still showing selector chrome.

## Explicitly out of scope

EIP-5792 1-click swap bundling (separate future follow-up, now unblocked for both V3 and V4 together once this ships), multi-hop/cross-pool routing, platform fee, simulated/paper trading, any change to V4's panel or to the Pools-tab pool-discovery/indexing work.

## Still open, to verify during implementation (not blocking spec approval)

- **`V3_SWAP_EXACT_IN`'s exact input-tuple field order/shape.** Confirmed the command byte dispatches into real V3 logic (hit `Path.sol`'s `SliceOutOfBounds()`, not a generic/unmatched-selector revert), but the probe's one attempted shape didn't fully succeed. The implementation plan's first task must iterate with further bounded `eth_call`s (varying field order, trying `payerIsUser: true` via a Permit2-style flow against a state-overridden allowance, etc.) against a real pool before relying on this for a real submitted transaction — same evidence gate the V4 plan applied to its own action encoding.
- **Native-ETH-out (`UNWRAP_WETH` combined with a real non-zero V3 swap, not just a standalone zero-amount probe).** Only tested in isolation with a zero amount; the implementation plan should do one bounded real-amount combined simulation before relying on it.
- Whether any Pons-launched token has a transfer tax that would break `amountOutMinimum` math — carried over, still unverified, from the original V3 spec.

## References

- `docs/superpowers/specs/2026-10-06-v3-pool-swap-design.md` — the original V3 swap spec this one migrates away from (its router/approval research, not its call shape, still applies)
- `docs/superpowers/specs/2026-10-07-v4-pool-swap-design.md` — the V4 swap spec this one mirrors architecturally; corrects that spec's unverified `MixedRouteQuoterV2` label for `0x7edd862aa08dD5Be664C21188E1A2A0E64e3A283`
- `fe/src/trading/v4-swap-panel.tsx`, `use-v4-swap-quote.ts`, `use-permit2-permit.ts`, `v4SwapEncoding.ts` — the reference implementation this phase's plan should follow the shape of
