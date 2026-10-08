# Unified Swap Panel Design

**Approved scope:** one Uniswap-style swap panel (two stacked Sell/Buy cards, flip arrow, full-width action button) used for every tradable venue — bonding curve, graduated V3 pool, graduated V4 pool — on launch detail and pool detail pages. A UI/composition change on the frontend only: no backend change, no migration, no change to any on-chain call shape, approval, quote, slippage or batching behavior already verified in the earlier trading specs.

Builds on `2026-10-06-launch-trading-design.md`, `2026-10-07-v3-pool-swap-permit2-migration-design.md`, `2026-10-07-v4-pool-swap-design.md` and `2026-10-08-eip5792-batch-swap-design.md`.

## Intent (agreed with the user)

The user shared a screenshot of Uniswap's swap panel and asked for the same look. Decisions made in conversation:

- A curve buy/sell is economically a swap (quote asset ⇄ launched token); only the contract call differs (direct `buy`/`sell` on the curve, no router, no Permit2). So the curve gets the same single swap panel; the flip direction selects `buy` vs `sell`.
- **No `Limit` tab** — nothing in the repo or on this chain supports limit orders; not faked, not shown disabled.
- **No `Buy | Sell` tab bar** in this work. Uniswap's tab row is deferred; this panel is a single "Swap" panel with no tabs.
- The venue stays visible to the user (curve vs. which pool), consistent with the project rule of always labeling the source.

## Components

### `TradeCard` (new, presentational only — `fe/src/trading/trade-card.tsx`)
Renders the two-card layout from the screenshot:
- Top card: label "Sell", large amount input, optional `$` line below, token pill (logo + symbol + chevron via the existing `TokenSelector`).
- Bottom card: label "Buy", read-only output value (large), optional `$` line, token pill. Slightly different background than the top card.
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

- `trade-card.test.tsx`: renders both cards; `$` line hidden when `usdValue` is null and shown when set; flip button calls back; output card is read-only.
- `swap-shell.test.tsx`: title, venue badge text per venue, settings gear present.
- `curve-swap-panel.test.tsx`: port every assertion from `buy-panel.test.tsx` and `sell-panel.test.tsx` — native-ETH buy sends `value` and skips approval; ERC20 buy and sell require exact-amount approval; batch path when `canBatch`; insufficient-balance disables the button; quote-unavailable message; direction flip clears amount and swaps tokens; query/allowance state does not leak between directions. This is the regression guard for the merge.
- V3/V4 panel tests: update selectors only; behavior assertions must stay and pass.
- Playwright smoke (`fe/e2e`): launch detail renders the Swap panel with the correct venue badge, and no `Limit`/`Buy`/`Sell` tabs.
- Full FE test suite, `tsc --noEmit` and lint pass.

## Out of scope

- `Limit` tab (no support), `Buy | Sell` tabs (deferred by the user), the chart shortcut icon in Uniswap's header.
- Any change to quoting, routing, fees, approvals, or the backend.
- USD values for the quote side / pool pages.
- Real trading changes of any kind (platform fee, etc.).
