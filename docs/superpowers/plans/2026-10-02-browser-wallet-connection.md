# Browser Wallet Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let visitors connect an injected browser wallet and identify whether it is on Robinhood Chain.

**Architecture:** Wagmi config discovers browser connectors and owns the connection. A client provider wraps the existing server-rendered pages; a focused header control renders connection, network, and error states.

**Tech Stack:** Next.js 16, React 19, Wagmi, TanStack React Query, Vitest.

**Spec:** [Browser wallet connection design](../specs/2026-10-02-browser-wallet-connection-design.md)

## Global Constraints

- Mainnet chain ID `4663`, RPC `https://rpc.mainnet.chain.robinhood.com`, native ETH.
- No account request on initial render; no signing, transactions, or backend auth.
- Preserve current server-rendered page data and unrelated dirty files on `main`.
- No WalletConnect QR flow or project ID.

## Review Focus

- Multiple injected wallets must be distinguishable when EIP-6963 providers are present.
- No wallet must yield a useful message, not a dead button.
- A rejected connection or switch must clear pending state and keep the visible connection state honest.
- Explicit disconnect must not immediately auto reconnect on rerender.
- Wrong chain must never be shown as ready for Robinhood Chain actions.

---

### Task 1: Wallet configuration and provider

**Files:** `fe/package.json`, `package-lock.json`, `fe/src/wallet/config.ts`, `fe/src/wallet/providers.tsx`, `fe/src/app/layout.tsx`, `fe/src/wallet/config.test.ts`.

**Interfaces:** Export `robinhoodChain`, `walletConfig`, and `WalletProviders({ children })`. The config uses injected connector discovery and `ssr: true`; only chain 4663 is configured. Providers supply Wagmi and React Query context without turning server pages into client modules.

- [x] Write a failing config test asserting chain ID, RPC, and injected provider discovery.
- [x] Run the focused test and confirm the missing configuration fails.
- [x] Install `wagmi`, `viem`, and `@tanstack/react-query` in the FE workspace; implement config/providers and wrap the root layout.
- [x] Run focused tests and FE typecheck.

### Task 2: Header wallet control

**Files:** `fe/src/wallet/wallet-control.tsx`, `fe/src/wallet/wallet-control.test.tsx`, `fe/src/components/app-shell.tsx`, `fe/src/components/app-shell.test.tsx`.

**Interfaces:** Export `WalletControl()`. It lists discovered browser wallets, connects only on a click, shortens the address, shows wrong-chain switch, exposes disconnect, and displays request errors. `AppShell` renders the control in its header.

- [x] Write failing tests for no wallet, multiple connectors, connection, rejection, wrong chain, switch error, and disconnect.
- [x] Run focused tests and confirm those states fail.
- [x] Implement the wallet control and update the header.
- [x] Run focused tests, full FE tests, typecheck, lint, and build.
- [x] Review the diff, preserve unrelated changes, and commit feature files on `main`.
