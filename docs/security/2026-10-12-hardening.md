# Security hardening — 2026-10-12

Scope: the local-first read-only app (`be/` API, `fe/`). Nothing deployed, no real funds touched.

## Checked, no finding
- Secrets: git history (573 commits) and tracked files hold only `.env.example` placeholders.
- `npm audit --omit=dev`: 0 vulnerabilities (now enforced in CI at `high`).
- FE links/images: website/twitter links pass `isHttpUrl`, logos go through `resolveLogoUrl`; no `dangerouslySetInnerHTML` except the theme script.
- Wallet and search inputs are validated (`isAddress`, integer bounds, query length).

## Fixed
| Finding | Fix |
|---|---|
| No rate limit; one client could burn the paid RPC quota or the DB | `@fastify/rate-limit`, 600/min/IP globally; 20/min on `/liquidity` and `/curve/depth` (36–400 RPC reads uncached) |
| Unlimited SSE streams, no heartbeat, no cleanup on socket error | 500 total / 10 per IP (429 beyond), 25 s heartbeat, release on `close` and `error` |
| Raw exception text (SQL, RPC URLs) could reach clients on 500 | Error handler returns `Internal server error` for 5xx, logs the real error |
| API had no security headers | `@fastify/helmet` (CSP `default-src 'none'`, nosniff, no framing) |
| FE had no script restrictions | Nonce-based CSP per request (`fe/src/proxy.ts`, `fe/src/lib/csp.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'` (no eval in production), `connect-src` limited to this origin + the configured API/RPC/paymaster origins, no framing, no plugins. Checked on a production build: no violations on list, token, pool, transactions and portfolio pages; hydration, charts and the inline theme script work; Playwright desktop+mobile pass when run with limited workers. Cost: every page is now rendered per request (required for nonces). Styles stay `'unsafe-inline'` because UI libraries inject `<style>` at runtime. |
| `chainId` list in search was unbounded | max 20 chains |
| FE had no security headers; token logos leaked visitor referrer to token creators' servers | `next.config.ts` headers (nosniff, DENY framing, referrer/permissions policy, safe CSP directives); logo `<img>` uses `referrerPolicy="no-referrer"` |

## User-facing trade warnings (added after the hardening pass)
- **Slippage setting** (`TradeSettingsPopover`): custom value above 5% (pool) / 25% (curve) warns about sandwiching; below 0.1% (pool) / 0.5% (curve) warns the trade may fail. `Auto` is never warned about.
- **Price impact** (`fe/src/trading/price-impact.ts`): shown in the swap card for V3, V4 and the curve. Computed as how much worse the trade's rate is than the rate of a 1% probe quote from the same quoter (the pool fee cancels). Pool: yellow from 5%, red from 15%; curve: from 15% / 30%. Unknown (no quote or trade too small to probe) shows nothing, never 0%.
- **Severe impact needs a tick**: the swap button stays disabled until the user ticks "I understand I will lose about X%"; the tick belongs to one amount, so changing the amount asks again. Approval is not blocked.
- Checked against real V3 pools on chain 4663: 0.001 ETH → 0.08%, 0.1 ETH → 6.7%, 1 ETH → 42% (monotonic, plausible).

## Open / operator actions
- Adding a new browser-called origin (another chain RPC, wallet SDK, analytics) requires listing it in `fe/src/proxy.ts`, or the browser will block it.
- Behind a reverse proxy set `API_TRUST_PROXY=true`, otherwise every client shares the proxy's IP in the limiter.
- Rate limits are in-memory per process; use a shared store if the API runs on several instances.
- Give the API a read-only database role (it only reads); workers keep the write role.
- Swap review (`fe/src/trading`): router/Permit2 addresses are constants; the Permit2 permit signs exactly `amountIn` with a short expiry and a nonce re-read before signing; the ERC20→Permit2 approval is `maxUint256` (same as Uniswap's own flow, Permit2 still limits what the router can pull). Fixed: slippage and deadline were read from `localStorage` unchecked and `applySlippage` allowed up to 100% (zero minimum output) — stored values are now sanitized and slippage is capped at 50%.
- On-chain slippage check (`fe/scripts/verify-v4-slippage.ts`, manual, `eth_call` only — nothing sent): against a real native-ETH V4 pool on chain 4663 (`0x4c9e…4b88`, fee 998112, tick spacing 19900), the app's own calldata succeeds with `amountOutMinimum = 1` and reverts with `amountOutMinimum = 2^128-1`, so the router really refuses to pay out less than the minimum the app encodes. Two other native-ETH pools reverted both ways (no usable liquidity or hook rules), so they prove nothing.
- Same check for V3 (`fe/scripts/verify-slippage.ts v3`, native ETH → token through WETH, pool fee 10000, token `0xf3cc…4b76`) and the bonding curve (`… curve <address>`, two live curves): minimum 1 succeeds, an unreachable minimum reverts. Both pass.
- Hostile tokens (fee-on-transfer, reverting hook) were not simulated: the minimum-output rule is enforced by the router/pool against what the pool pays out, so a token that skims on transfer after payout is outside what calldata can protect. Mitigation is product-side (show a warning for tokens whose transfer amount differs from the quote), not a calldata fix.
- E2E: whole-suite Playwright failures were timeouts from oversubscribed workers, not the CSP. The server answers pages in ~10–30 ms; with `workers: 3` all 59 specs pass.
