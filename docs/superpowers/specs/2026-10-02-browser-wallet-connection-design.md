# Browser Wallet Connection Design

**Approved scope:** Connect browser wallets first. No signing, trading, backend account, or WalletConnect QR flow in this change.

## User flow

- The site header shows **Connect wallet** before a connection. Clicking it lists available injected browser wallets; selecting one requests accounts only after the click.
- After connection, the header shows a shortened address and **Disconnect**. Account and chain changes in the wallet update the header. A prior authorized connection can restore after reload; an explicit disconnect remains disconnected.
- A connected wallet on any chain other than Robinhood Chain mainnet shows **Switch to Robinhood Chain**. Switching uses the wallet's network request. If the wallet cannot switch or the user rejects it, the connection remains visible and an actionable error appears.
- With no detected browser wallet, the UI says a browser wallet is needed. User rejection and provider errors do not leave the UI stuck in a pending state.
- The wallet state is client side only. Public launch pages still render without a wallet and never request accounts on page load.

## Implementation

- Use Wagmi injected connectors, including its EIP-6963 discovery, with React Query. No WalletConnect project ID is required.
- Configure only Robinhood Chain mainnet: chain ID `4663`, native ETH, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`.
- Put Wagmi and React Query providers in a small Client Component under the root server layout. Keep page data fetching on the server. A wallet control in `AppShell` consumes the provider.
- The wallet control owns only presentation and pending/error state. Wagmi owns connection, reconnect, account, and chain state. No secret or private key enters the app.

## Verification

- Component tests cover unavailable wallet, connector selection, connected address, wrong chain and switch, disconnect, and rejected requests.
- FE test, typecheck, lint, and production build pass. Browser wallet behavior is manually checked where a wallet extension is available; automated tests never require a real extension.

## References

- [Robinhood Chain connection settings](https://docs.robinhood.com/chain/connecting/)
- [Wagmi injected wallet discovery](https://wagmi.sh/react/api/createConfig)
