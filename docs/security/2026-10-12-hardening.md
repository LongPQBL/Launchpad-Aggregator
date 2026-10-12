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
| `chainId` list in search was unbounded | max 20 chains |
| FE had no security headers; token logos leaked visitor referrer to token creators' servers | `next.config.ts` headers (nosniff, DENY framing, referrer/permissions policy, safe CSP directives); logo `<img>` uses `referrerPolicy="no-referrer"` |

## Open / operator actions
- Behind a reverse proxy set `API_TRUST_PROXY=true`, otherwise every client shares the proxy's IP in the limiter.
- Rate limits are in-memory per process; use a shared store if the API runs on several instances.
- Give the API a read-only database role (it only reads); workers keep the write role.
- Full script-src CSP for the FE needs nonces (Next inline scripts, theme script, wallet SDKs); not attempted to avoid breaking the app.
- Swap review (`fe/src/trading`): router/Permit2 addresses are constants; the Permit2 permit signs exactly `amountIn` with a short expiry and a nonce re-read before signing; the ERC20→Permit2 approval is `maxUint256` (same as Uniswap's own flow, Permit2 still limits what the router can pull). Fixed: slippage and deadline were read from `localStorage` unchecked and `applySlippage` allowed up to 100% (zero minimum output) — stored values are now sanitized and slippage is capped at 50%.
- Still to do before real-money use: a fork/anvil test that simulates each swap with a hostile pool (fee-on-transfer token, hook that reverts) and confirms the minimum-output check protects the user.
