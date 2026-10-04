// Pinata is the only publicly-reachable IPFS gateway verified working against a real token logo
// this session — ipfs.io returned 429 (rate-limited), cloudflare-ipfs.com's DNS no longer
// resolves at all. Do not add either without re-verifying.
const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

export function resolveLogoUrl(uri: string | null): string | null {
  if (uri === null) return null;
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice('ipfs://'.length);
  return uri;
}
