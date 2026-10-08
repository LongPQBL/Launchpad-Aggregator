# Unified Swap Panel Design

**Approved scope:** one Uniswap-style swap panel (two stacked Sell/Buy cards, flip arrow, full-width action button) used for every tradable venue — bonding curve, graduated V3 pool, graduated V4 pool — on launch detail and pool detail pages. A UI/composition change on the frontend, plus one additive backend field (`quotePriceUsd` on the launch detail, see "USD lines"): no migration, no change to existing API fields, and no change to any on-chain call shape, approval, quote, slippage or batching behavior already verified in the earlier trading specs.

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
- A "Min received" row between the cards and the footer (see "Min received line"); hidden when there is no quote.
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

**Deriving `X` (reverse quote)** is per venue; every path returns the smallest input found whose exact-input quote covers the typed target (within 0.01%), or "no answer":

- **V3 — one call.** The deployed `QuoterV2.quoteExactOutputSingle` returns the required input directly (verified on chain 4663: exact-out for 1e12 token1 → 143,432,958 token0, matching the exact-in rate).
- **V4 — parallel search.** The deployed quoter exposes only `quoteExactInputSingleV4`, so `solveInputForOutput` inverts it.
- **Curve — parallel search over the real `buy()`/`sell()` simulation**, which already includes every fee and the time/address-dependent snipe tax.

**The search (`solveInputForOutput`)** is parallel, not sequential. Each *round* probes up to 16 inputs at once (one network round trip, ~380 ms on the public RPC), then narrows the bracket ~9× per round; typical cost is a handful of rounds, not 20–30 sequential calls (a sequential search measured ~1.1 s/call from the CLI, ~30 calls for one curve). A revert is classified by context: a revert below every input that has succeeded is *dust* (the curve reverts tiny trades, e.g. `sell` of 1e6 raw tokens → `0x42301c23`) and means "too small"; a revert above a succeeded input means "too large" (over capacity or over balance). Rounds and probes are capped; if every probe fails twice, or the cap is reached, there is no answer.

**Curve simulations run as a synthetic account with state overrides.** An ERC20-quoted `buy` and any `sell` revert in `eth_call` with `InsufficientAllowance()` until the account holds the spent token and has approved the curve (observed live on the GB/USDG curve for 1, 5 and 20 USDG). `eth_call` accepts a state override ("pretend this storage slot holds this value, for this run only"), so the simulation uses a fixed account (`0x…a11ce`) that is *given* a maximal balance and curve allowance (native-ETH buys are given an ETH balance instead). Consequences: the reverse quote works **before approval and without a connected wallet**, and never depends on the user's own balance.
- The override needs the spent token's storage slots, which differ per token. They are **discovered** by writing a probe value into a candidate slot and reading it back through the token's own `balanceOf`/`allowance`; the result is cached per token for the session. Verified on chain 4663: USDG balance@1 / allowance@3; Pons launch tokens balance@0 / allowance@1; stock tokens (NVDA, TSLA, SPCX, GME, SPY) use OpenZeppelin-5 namespaced storage (`0x52c63247…ace00`, allowance at `+1`). WETH (an EIP-1967 proxy) was not discoverable, but WETH is never a curve quote asset (every WETH-quoted launch is V1, a V3 pool). If a token's slots cannot be discovered, there is no reverse quote for that token and **no trade is simulated** — "Quote unavailable", never a guess.
- Verified end to end with an empty random account: native-ETH buy of 0.001 ETH → 5.889e23 tokens, identical to the real trader's result; SPCX-quoted buy → 2.73e25 (matching Pons's displayed 27.28M for 1 SPCX); `sell` works and reverts only past the amount the curve has actually sold.
- Limitation: during a launch's first seconds (snipe tax, per-address) the synthetic account can be quoted differently from the user's account. The forward quote at the derived input (real account) stays the authority for "Min received" and submission.

**Closed-form starting guess (curve).** The curve is constant-product with virtual reserves and a fee, and the following reproduces the real simulations *exactly* (verified at one block on the OBUL curve, `feeBps = 100`): `buy`: `net = floor(in·(10000−fee)/10000)`, `out = floor(tokenReserve·net / (quoteReserve + net))`; `sell`: `gross = floor(quoteReserve·t / (tokenReserve + t))`, `out = gross − floor(gross·fee/10000)` (reserves from `quoteReserve()`/`tokenReserve()`, fee from `feeBps()`). It is used **only** as the search's initial guess (inverted in closed form); the simulation always decides, so a wrong guess (snipe-tax window, creator tax, formula drift) costs only extra rounds, never a wrong answer.

**Out of scope here:** true on-chain exact-output execution for V3 (Universal Router `V3_SWAP_EXACT_OUT`, command `0x01`, `amountInMax`), which would change the Permit2 approval amount math; and applying the same state-override trick to the *forward* quote so it also works before approval (today the forward quote for ERC20-quoted buy/sell still needs approval first — unchanged existing behavior). Execution stays exact-input on every venue.

**Display:** the derived side is shown with `≈`-free plain numbers (it is a real simulated quote) but labeled in the helper line as an estimate, same as today's "You receive ≈". When typing in Buy, the Sell card shows the derived input and the "insufficient balance" check runs against it.

## Min received line

Below the cards (above the action button) the panel shows `Min received  <amount> <symbol>` — the least the user will accept after slippage, as on Pons ("min 27.0063M PROMETHEUS").

- The value is `applySlippage(quote.outputAmount, settings.slippageBps, venueKind)` — the **same function and the same inputs** that compute the on-chain `minTokensOut` / `minQuoteOut` / `amountOutMinimum`, so the number shown is exactly the number submitted.
- Shown only when a quote exists (`outputAmount !== null`); otherwise the row is hidden — never a placeholder `0`.
- Formatted compactly (e.g. `27.0063M`, up to 4 fraction digits; a real non-zero amount below `0.0001` shows `<0.0001`, never `0`).
- When the user typed in the Buy box, the row is computed from the forward quote at the derived input `X`, same as submission.
- **Slippage itself stays in the settings popover** (`TradeSettingsPopover`: Auto or custom %, deadline), as on Uniswap — no slippage chips or inputs on the panel face. The row does not repeat the slippage percentage.

## USD lines

Each card shows, under its amount, the USD value of that amount: `amount × that token's own USD price`. This is what Uniswap does (screenshot: 50 ETH → $123,708.03; 1,352,430 AI → $118,356.62). **The two lines legitimately differ**: each side is valued at its own market price, so the gap is the price impact plus the pool/curve fee — the user can see at a glance what the trade costs (here −4.3%).

`$` is shown only when a real USD price exists — never a placeholder `$0` (null means unavailable, per project rules). A side without a price hides its line; the other side's still shows.

- **Launched token:** `detail.priceUsd` (already exposed; withheld by the API while indexed coverage is incomplete).
- **Quote asset:** a new additive field `detail.quotePriceUsd` — USD per whole unit of the launch's quote asset, from the same verified Chainlink feed the backend already uses for `priceUsd` (`readUsdPrice` / `quote_usd_feeds`). Detail endpoint only (the list endpoint is untouched); independent of coverage; `null` when the quote asset has no verified feed, the API has no RPC client, or the read fails — and a failure never fails the detail request. No migration.
- The panel takes a `usdPrices` map (lowercased token address → USD price or `null`); the launch page builds it from the two fields above. The V3 panel's WETH leg and the V4 native-ETH leg both resolve through the quote asset's address.
- **Pool detail page:** no per-currency USD prices are passed there, so its `$` lines stay hidden. Giving the Pools page the same two-sided USD lines (e.g. from pool-level price data) is a follow-up, not part of this work.
- Formatting follows the app's existing `formatUsd` (no thousands separators, e.g. `$3000.00`); changing that is out of scope.

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

- `trade-amount-format.test.ts`: compact formatting (`27_006_300…` → `27.0063M`, thousands, small, `<0.0001`, zero).
- `trade-card.test.tsx`: renders the Min received row only when provided; renders both cards; `$` line hidden when `usdValue` is null and shown when set; flip button calls back; both inputs editable and typing in one reports which side is the source.
- `solve-input-for-output.test.ts`: against fake monotonic quote functions (linear, convex curve-like, dust reverts below a minimum size, null above capacity, unreachable target, always-failing) — result satisfies `quoteFn(X) >= target`, is minimal within 0.01%, runs probes in parallel, respects the round cap, aborts, returns null when unsolvable, and solves from both an accurate and a badly wrong `initialGuess`.
- `erc20-state-override.test.ts`: slot discovery for the USDG, Solmate and OZ5-namespaced layouts and a second-stage layout, null for an unsupported layout or failing node, per-token cache, override shape.
- `curve-guess.test.ts`: the closed-form model reproduces the six live `buy`/`sell` results exactly; guesses land within 0.01%; null for impossible targets.
- `reverse-quote.test.ts`: per-venue builders against a fake chain (V3 single call; V4 and curve search; native-ETH buy, ERC20 buy and sell with overrides; unsupported token → no trade simulated; works without a wallet).
- Panel tests per venue (reverse builder mocked at its module boundary): typing in Buy derives Sell and submits the normal exact-in call with the derived amount; typing in Sell never calls the solver; flip keeps the typed token as source; the curve panel works without a connected wallet; unsolvable target shows "Quote unavailable" and disables the button.
- `swap-shell.test.tsx`: title, venue badge text per venue, settings gear present.
- `curve-swap-panel.test.tsx`: port every assertion from `buy-panel.test.tsx` and `sell-panel.test.tsx` — native-ETH buy sends `value` and skips approval; ERC20 buy and sell require exact-amount approval; batch path when `canBatch`; insufficient-balance disables the button; quote-unavailable message; direction flip clears amount and swaps tokens; query/allowance state does not leak between directions. This is the regression guard for the merge.
- V3/V4 panel tests: update selectors only; behavior assertions must stay and pass.
- Playwright smoke (`fe/e2e`): launch detail renders the Swap panel with the correct venue badge, and no `Limit`/`Buy`/`Sell` tabs.
- Full FE test suite, `tsc --noEmit` and lint pass.

## Out of scope

- `Limit` tab (no support), `Buy | Sell` tabs (deferred by the user), the chart shortcut icon in Uniswap's header.
- Exact-output on-chain execution (the reverse path only derives an exact-input amount), routing, fees, approval semantics, or any backend change other than the one additive `quotePriceUsd` field.
- USD lines on the Pools page (follow-up).
- Real trading changes of any kind (platform fee, etc.).
