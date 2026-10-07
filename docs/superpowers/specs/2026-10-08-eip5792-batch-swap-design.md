# EIP-5792 "1-Click Swap" Batch-Call Design

**Approved scope:** for wallets that support EIP-5792 atomic call batching, bundle the one-time `ERC20→Permit2` approval transaction and the swap's `UniversalRouter.execute()` transaction into a single `wallet_sendCalls` request, so a first-time swap of a token needs one on-chain confirmation instead of two. V3 (`fe/src/trading/swap-panel.tsx`) and V4 (`fe/src/trading/v4-swap-panel.tsx`) swap panels only — this is CLAUDE.md's deferred item 2, now unblocked since item 1 (migrating V3 to Universal Router + Permit2) shipped (commits `163dc5a..e225314`). The curve Buy/Sell panels (`buy-panel.tsx`/`sell-panel.tsx`) are explicitly out of scope — they use a plain `ERC20→curve` approval, not Permit2, and were a deliberate scope decision (see "Explicitly out of scope").

The signed Permit2 `PermitSingle` message itself is never batchable — it is an off-chain EIP-712 signature, not an on-chain call — and continues to be obtained exactly as it is today, before any submission (single or batched) happens.

## Why this is safe to build now

Both swap panels already avoid a *second* on-chain approval for the swap itself: the Permit2 signature is bundled as a `PERMIT2_PERMIT` command inside the same `UniversalRouter.execute()` call as the swap (`v4-swap-panel.tsx:94-109`, `swap-panel.tsx:100-146`). The only remaining separate on-chain transaction is the one-time `ERC20.approve(Permit2, maxUint256)` bootstrap approval (`use-token-allowance.ts`), shown today via `ApproveOrActionButton`'s two-step Approve-then-Swap UI. This is exactly the one call EIP-5792 batching can fold into the swap transaction.

## Wallet capability detection

A new hook, `useCanBatchCalls(): boolean`, wraps wagmi's `useCapabilities({ account, chainId: robinhoodChain.id })` (wagmi 3.7.7 already exports this — confirmed in `node_modules`, no new dependency). Returns `true` only when `capabilities.atomic?.status === 'supported'`.

`'supported'` is the only value trusted — EIP-5792 also defines `'ready'` (wallet *could* support atomic batching if the user opts in, not guaranteed) and `'unsupported'`. Treating `'ready'` as supported risks a `wallet_sendCalls` call that does not execute atomically, which could land the approval without the swap. Only `'supported'` is a wallet's unconditional commitment to atomic execution.

This hook is called once per panel render; wagmi's own query caching means reconnecting the same account/chain doesn't re-trigger the RPC call.

## Submission: extending `use-trade-submission.ts`

`useTradeSubmission()` gains a second submit function alongside the existing `submit` (unchanged, still backs the no-approval-needed and legacy two-step-approval paths):

```ts
export interface TradeSubmission {
  submit: ReturnType<typeof useWriteContract>['writeContract'];
  submitBatch: (calls: readonly SendCallsParameters['calls'][number][], options?: { onSuccess?: () => void }) => void;
  status: TradeSubmissionStatus;
  txHash: Address | undefined;
  errorMessage: string | null;
}
```

Internally, `submitBatch` calls wagmi's `useSendCalls().sendCalls({ calls })`, then `useWaitForCallsStatus({ id })` tracks completion. `calls` reuses the exact same `{ address, abi, functionName, args, value? }` shape already passed to `submit()` today — viem's `Calls<>` type accepts this contract-call shape directly (confirmed in `node_modules/viem/_types/types/calls.d.ts`), so no new call-encoding code is needed; the approve call and the existing `execute()` call object are just placed in one array.

Status mapping, unified with the existing single-call path so `TradeStatus` needs zero changes. Viem's `getCallsStatus` (which `useWaitForCallsStatus` wraps) already normalizes the raw EIP-5792 status code into a friendly `status: 'pending' | 'success' | 'failure'` (confirmed in `node_modules/viem/_types/actions/wallet/getCallsStatus.d.ts` — no need to interpret raw status-code ranges):

| `useSendCalls`/`useWaitForCallsStatus` state | `TradeSubmissionStatus` |
|---|---|
| `sendCalls` pending (wallet prompt open) | `'pending'` |
| call ID returned, `useWaitForCallsStatus`'s own `status` is `'pending'` | `'confirming'` |
| `useWaitForCallsStatus`'s `status` is `'success'` | `'confirmed'` |
| `useWaitForCallsStatus`'s `status` is `'failure'`, or `sendCalls` itself errored | `'failed'` |

`txHash` is read from `receipts[receipts.length - 1].transactionHash`. Because `'supported'` atomic batching guarantees both calls land in the same on-chain transaction, every receipt in the batch shares one `transactionHash` — taking the last one is just a convenient, always-correct way to get it, not a meaningful choice among different transactions. This is what backs the existing "View transaction" explorer link in `TradeStatus` unchanged.

`errorMessage` reuses `decodeTradeError` on whatever error `sendCalls`/`useWaitForCallsStatus` surfaces (a declined wallet prompt, a reverted batch), the same decoder already used for the single-call path — no new error-message code.

## Button and submit-flow changes

`ApproveOrActionButton` gains one new prop, `canBatchApprove?: boolean` (defaults falsy, so every existing call site is unaffected unless explicitly opted in). Its `needsApproval` branch changes from:

```
needsApproval → always render the plain "Approve" button
```

to:

```
needsApproval && !canBatchApprove → plain "Approve" button (unchanged)
needsApproval && canBatchApprove  → render the normal action button (same branch as !needsApproval), calling the same onAction callback
```

No label change — per the approved design, the button always reads `actionLabel` ("Swap"); there is no separate "Approve & Swap" wording. A wallet that can't batch still sees today's two-step Approve-then-Swap flow with zero behavior change.

Each panel's `submitSwap()` (already doing the Permit2-signing step identically in both panels) gains one new branch at the point it currently calls `submission.submit(executeCallRequest, ...)`:

```ts
const approveCall = { address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, maxUint256] };
const executeCall = { address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute', args: [commands, inputs, deadline], value: ... };

if (needsErc20Approval && canBatch) {
  submission.submitBatch([approveCall, executeCall], { onSuccess: () => setAmount('') });
} else {
  submission.submit(executeCall, { onSuccess: () => setAmount('') });
}
```

`needsErc20Approval` is only ever `true` here when `canBatchApprove` was also true at the button level (otherwise the plain "Approve" branch handles it and `submitSwap` is never reached with approval still pending) — so this branch is reachable exactly when expected, not a new independent code path to desync from the button state.

Each panel passes `canBatchApprove={canBatch}` to its `ApproveOrActionButton`, where `const canBatch = useCanBatchCalls()`.

## Error handling

No new UI states. Three cases, all already covered by existing machinery:

- **Wallet declines the batch prompt:** surfaces through `submission.errorMessage`/`'failed'` status exactly like a declined single `execute()` call today, rendered by the unchanged `TradeStatus`.
- **Wallet claimed `'supported'` but the batch itself errors:** same as above — this is treated as an ordinary submission failure, not a special "batching broke" state, since `'supported'` is meant to be a reliable commitment and a 1-in-many failure doesn't need its own UX.
- **Permit2 signature declined:** unchanged from today — `submitSwap` already returns early on a thrown `signPermit()`, before either `submit` or the new `submitBatch` is ever called.

## Testing plan

New/updated Vitest coverage, following this codebase's existing mock-wagmi-hooks convention (see `swap-panel.test.tsx`'s `useWriteContract`/`useWaitForTransactionReceipt` mocks):

- `use-can-batch-calls.test.ts` (new): resolves `true` only when `useCapabilities` returns `atomic.status === 'supported'`; `false` for `'ready'`, `'unsupported'`, and no capability entry at all.
- `use-trade-submission.test.ts`: extend with `submitBatch` coverage — maps `useSendCalls`/`useWaitForCallsStatus` states to the same `TradeSubmissionStatus` values the existing `submit` tests already assert, and reads `txHash` from the last receipt.
- `approve-or-action-button.test.tsx`: `needsApproval && canBatchApprove` renders the action button (not "Approve") and calls `onAction` directly; `needsApproval && !canBatchApprove` is unchanged (existing tests already cover this and must keep passing untouched).
- `swap-panel.test.tsx` / `v4-swap-panel.test.tsx`: add a case per panel where `useCapabilities` mocks `'supported'` and an approval is needed — asserts `submitBatch`-equivalent (`sendCalls`) is called with exactly `[approveCall, executeCall]` in that order, and that the plain two-step path (existing "shows Approve..." tests) is unaffected when `useCapabilities` mocks `'unsupported'`.

## Explicitly out of scope

- **Curve Buy/Sell panels.** Confirmed with the user: this spec's scope is the Permit2-based V3/V4 swap flows only. `buy-panel.tsx`/`sell-panel.tsx` use a plain `ERC20→curve` approval with no Permit2 involved; applying EIP-5792 there would be a structurally similar but separate change, left for later if wanted.
- **`'ready'`-status wallets.** Only `atomic.status === 'supported'` enables batching; a `'ready'` wallet always gets today's two-step flow. Revisiting this (e.g. prompting the user to opt in) is a separate future decision, not assumed here.
- **Paymaster / sponsored-gas capabilities.** EIP-5792 also defines a `paymasterService` capability; this spec only reads `atomic`, and does not add any paymaster support.
- **Any change to `TradeStatus`, `decodeTradeError`, or the Permit2 signing flow itself** — all three are reused unchanged.
