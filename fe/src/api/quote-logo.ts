const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// The native asset has no on-chain or directory logo, so the zero address maps to a bundled icon; every other
// quote asset uses the logo the API resolved for it (null when none is known — the UI then shows a letter).
export function quoteLogoUri(address: string, logoUri: string | null): string | null {
  if (logoUri !== null) return logoUri;
  return address.toLowerCase() === ZERO_ADDRESS ? '/images/tokens/eth.svg' : null;
}
