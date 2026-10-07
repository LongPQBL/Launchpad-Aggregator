// Unset in every real environment today — no Alchemy Gas Manager (or ZeroDev) policy has been
// configured for Robinhood Chain (chain 4663) yet. Left undefined keeps gas sponsorship fully
// inert: no panel ever attaches a paymasterService capability without this being set.
export const PAYMASTER_SERVICE_URL = process.env.NEXT_PUBLIC_PAYMASTER_SERVICE_URL || undefined;
