# Unified Swap Panel Design

**Approved scope:** one Uniswap-style swap panel (two stacked Sell/Buy cards, flip arrow, full-width action button) used for every tradable venue — bonding curve, graduated V3 pool, graduated V4 pool — on launch detail and pool detail pages. A UI/composition change on the frontend only: no backend change, no migration, no change to any on-chain call shape, approval, quote, slippage or batching behavior already verified in the earlier trading specs.

Builds on `2026-10-06-launch-trading-design.md`, `2026-10-07-v3-pool-swap-permit2-migration-design.md`, `2026-10-07-v4-pool-swap-design.md` and `2026-10-08-eip5792-batch-swap-design.md`.

## Intent (agreed with the user)

The user shared a screenshot of Uniswap's swap panel and asked for the same look. Decisions made in conversation:

- A curve buy/sell is economically a swap (quote asset ⇄ launched token); only the contract call differs (direct `buy`/`sell` on the curve, no router, no Permit2). So the curve gets the same single swap panel; the flip direction selects `buy` vs `sell`.
- **Both inputs are editable (two-way):** typing in Sell computes Buy, typing in Buy computes Sell, as on Uniswap.
- **No `Limit` tab** — nothing in the repo or on this chain supports limit orders; not faked, not shown disabled.
- **No `Buy | Sell` tab bar** in this work. Uniswap's tab row is deferred; this panel is a single "Swap" panel with no tabs.
- The venue stays visible to the user (curve vs. which pool), consistent with the project rule of always labeling the source.

## Components

### `TradeCard` (new, presentational only — `fe/src/trading/trade-card.tsx`)
Renders the two-card layout from the screenshot:
- Top card: label "Sell", large amount input, optional `$` line below, token pill (logo + symbol + chevron via the existing `TokenSelector`).
- Bottom card: label "Buy", large amount input (editable), optional `$` line, token pill. Slightly different background than the top card.
- Both inputs are editable. The card the user last typed in is the "source"; the other card shows the derived amount (see Two-way quoting).
- Flip button overlapping the seam between the cards (existing "Flip swap direction" behavior and aria-label retained).
- A `footer` slot below the cards for the action button and status.

It owns no trade logic: it receives value/onChange, selector configs, `usdValue` (nullable) and callbacks as props.

### `SwapShell` (new — `fe/src/trading/swap-shell.tsx`)
Header row: "Swap" title, a small venue badge ("Bonding curve" / "Uniswap V3 pool" / "Uniswap V4 pool"), and the existing `TradeSettingsPopover` gear. Body is `TradeCard`. The existing `venueKind` ('curve' | 'pool') still drives settings defaults.

### `CurveSwapPanel` (new — replaces `BuyPanel` + `SellPanel` + `CurveTradePanel`)
Holds a `direction` state (`'buy' | 'sell'`, initial `'buy'` = quote → token). Calls the same hooks as today (`useCurveQuote`, `useTokenAllowance`, `useTradeSubmission`, `useCanBatchCalls`, `usePaymasterCapability`, `useRefetchQuoteAfterApproval`, `ApproveOrActionButton`) — behavior per direction is copied unchanged from `buy-panel.tsx` / `sell-panel.tsx`:

| Direction | Call | Approval | Notes |
|---|---|---|---|
| buy, native-ETH quote | `curve.buy(amountIn, minTokensOut, account)` with `value = amountIn` | none | single transaction |
| buy, ERC20 quote | same, no `value` | exact-amount `approve(curve, amountIn)` (never `maxUint256`) | batchable with EIP-5792 |
| sell | `curve.sell(amountIn, minQuoteOut, account)` | exact-amount `approve(curve, amountIn)` | batchable |

Switching direction clears the amount (as V3/V4 panels already do on flip). Because hooks cannot be called conditionally per direction, the plan will split the per-direction state/hooks so both directions' hooks are called unconditionally with `enabled`/`undefined` args gating them (the existing hooks already accept `undefined` addresses and `enabled` flags — e.g. `useTokenAllowance(undefined, …)` and the `query.enabled` pattern in `BuyPanel`).

### `SwapPanel` (V3) and `V4SwapPanel` — JSX only
Replace their hand-rolled Sell/Buy markup with `SwapShell` + `TradeCard`. Permit2 signing, batching, quote hooks, ETH/WETH toggle (`TokenSelector` options), slippage, deadline — untouched.

### `SwapPanelPreview`
Reuses `TradeCard` with the same fake data and the same "Preview only" disabled button/label, shown under the same condition as today.

## Two-way quoting

Today every venue is quoted exact-input only (type in Sell → quote Buy). Typing in Buy needs the reverse.

**State:** `lastEdited: 'sell' | 'buy'` plus the typed string for that side. The other side's displayed value is derived, never stored as typed text. Flipping direction swaps the cards, keeps `lastEdited` pointing at the same token (the token the user typed in stays the source), and keeps the typed amount.

**Execution never changes.** Every venue still executes exact-input, using the call shapes already verified (curve `buy`/`sell`, Universal Router V3/V4 exact-in). When the user typed in Buy, the panel first derives the input amount `X` that yields at least the typed target, then runs the normal exact-in flow with `X` — slippage (`minOut`), balance check, approval and batching all use `X` exactly as if the user had typed `X` in Sell. No exact-output on-chain commands, no new approval math.

**Deriving `X` (reverse quote):** a non-hook helper `solveInputForOutput(quoteFn, targetOut)` in `fe/src/trading/` inverts a monotonic exact-in quote function (`quoteFn(amountIn) → amountOut | null`) with a bounded search: exponential bracket from an initial guess, then bisection until `quoteFn(X) >= targetOut` and the bracket width is within one raw unit or a small relative tolerance (≤0.01% of `X`), hard-capped at a fixed iteration count. It returns the smallest `X` found with `quoteFn(X) >= targetOut`, so the user receives at least the typed amount before slippage. If the cap is hit, the quote function returns null/throws, or no `X` is found (e.g. target exceeds what the pool/curve can deliver), the Sell card shows "Quote unavailable" and the button is disabled — it does not guess.
- `quoteFn` is built per venue from the same simulations the exact-in hooks already use (`simulateContract` against the curve, the V3 quoter, the V4 quoter) via the wagmi public client, so the reverse path cannot drift from what execution will actually do.
- Calls are debounced (reuse the panel's amount debounce, ~300 ms) and a stale search is cancelled when the typed value changes, so a fast typist does not pile up RPC requests.
- The iteration cap and tolerance are tunable constants; the plan's first task measures actual call count and latency per venue against the live RPC before fixing them, and records the numbers. Before fixing them, the plan re-verifies the findings below.
- **Verified on chain 4663 (2026-10-09, public RPC `eth_call`, not assumed):**
  - **V3:** `QuoterV2.quoteExactOutputSingle` (`0x33e885eD…A9E7`) works and is consistent with exact-in. Pool `0x10cc6bd3…26ba` (fee 10000): exact-in 1e18 token0 → 6.9668e21 token1; exact-out for 1e12 token1 → 143,432,958 token0 in, matching the exact-in rate. V3 therefore derives `X` with **one** call, no search.
  - **V4:** the deployed quoter (`0x7edd862a…A283`) exposes only `quoteExactInputSingleV4` — its bytecode has no `quoteExactOutputSingle`/`…V4` selector (the exact-in-only mixed-route quoter). V4 uses the bounded search over `quoteExactInputSingleV4`.
  - **Curve:** the curve contract has no quote or exact-output view. It exposes reserves (`getReserves`, `tokenReserve`, `quoteReserve`, `realQuoteReserve`, `phantomQuote`) and fee/tax state (`feeBps`, `feePolicy`, `currentSnipeTaxBps(address)`, creator tax). A closed-form inverse would have to reproduce the fee policy and a time- and address-dependent snipe tax — unverified and drift-prone. The curve uses the bounded search over the real `buy`/`sell` simulation, which already includes every fee and tax by construction.
- True on-chain exact-output execution for V3 (Universal Router `V3_SWAP_EXACT_OUT`, command `0x01`, `amountInMax`) is a possible follow-up, not part of this work, because it changes the Permit2 approval amount math. Execution stays exact-input on every venue.

**Display:** the derived side is shown with `≈`-free plain numbers (it is a real simulated quote) but labeled in the helper line as an estimate, same as today's "You receive ≈". When typing in Buy, the Sell card shows the derived input and the "insufficient balance" check runs against it.

## USD line

`$` is shown only when the frontend already has a real USD price — never a placeholder `$0` (null means unavailable, per project rules):
- Launch detail: the launched-token side shows `amount × detail.priceUsd` when `detail.priceUsd !== null`. The other (quote) side's `$` line is hidden in this work.
- Pool detail: no `priceUsd` is passed, so both `$` lines are hidden.

Wider USD coverage (quote-asset feed on the frontend) is a possible follow-up, not part of this work.

## Venue mapping (unchanged rule, new presentation)

| Page | Venue | Panel |
|---|---|---|
| Launch detail | active curve venue | `CurveSwapPanel` |
| Launch detail | active V3 venue | `SwapPanel` |
| Launch detail | active V4 venue | `V4SwapPanel` |
| Launch detail | no tradable venue | `SwapPanelPreview` (unchanged condition) |
| Pool detail | any V2/V3/V4 pool | existing `SwapTrigger` dialog, now rendering the new look |

`curve-trade-panel.tsx`, `buy-panel.tsx`, `sell-panel.tsx` and their tests are removed once `CurveSwapPanel` covers every behavior they tested.

## Styling

Follows the app's current theme tokens (dark default, light supported). The primary button uses the theme's primary/accent token; no new color is introduced. The lime used on the Pool page's Swap trigger is unrelated and not changed here.

## Testing

- `trade-card.test.tsx`: renders both cards; `$` line hidden when `usdValue` is null and shown when set; flip button calls back; both inputs editable and typing in one reports which side is the source.
- `solve-input-for-output.test.ts`: against fake monotonic quote functions (linear, convex curve-like, flat-then-steep, quote returning null mid-search, target unreachable) — result satisfies `quoteFn(X) >= target`, is minimal within tolerance, respects the call cap, returns null when unsolvable.
- Panel tests per venue: typing in Buy derives Sell and submits the normal exact-in call with the derived amount; typing in Sell still derives Buy; flip keeps the typed token as source; a changing target cancels the previous search; unsolvable target shows "Quote unavailable" and disables the button.
- `swap-shell.test.tsx`: title, venue badge text per venue, settings gear present.
- `curve-swap-panel.test.tsx`: port every assertion from `buy-panel.test.tsx` and `sell-panel.test.tsx` — native-ETH buy sends `value` and skips approval; ERC20 buy and sell require exact-amount approval; batch path when `canBatch`; insufficient-balance disables the button; quote-unavailable message; direction flip clears amount and swaps tokens; query/allowance state does not leak between directions. This is the regression guard for the merge.
- V3/V4 panel tests: update selectors only; behavior assertions must stay and pass.
- Playwright smoke (`fe/e2e`): launch detail renders the Swap panel with the correct venue badge, and no `Limit`/`Buy`/`Sell` tabs.
- Full FE test suite, `tsc --noEmit` and lint pass.

## Out of scope

- `Limit` tab (no support), `Buy | Sell` tabs (deferred by the user), the chart shortcut icon in Uniswap's header.
- Exact-output on-chain execution (the reverse path only derives an exact-input amount), routing, fees, approval semantics, or the backend.
- USD values for the quote side / pool pages.
- Real trading changes of any kind (platform fee, etc.).
