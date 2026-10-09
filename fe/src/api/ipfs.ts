import { isHttpUrl } from './url';

// Pinata is the only publicly-reachable IPFS gateway verified working against a real token logo
// this session — ipfs.io returned 429 (rate-limited), cloudflare-ipfs.com's DNS no longer
// resolves at all. Do not add either without re-verifying.
const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

// A real CID (base32 or base58) is alphanumeric; an optional /subresource path may follow it.
// Rejects path traversal (`..`), query strings, and fragments before they reach the gateway URL.
const CID_PATH_PATTERN = /^[A-Za-z0-9]+(\/[^?#]*)?$/;

export function resolveLogoUrl(uri: string | null): string | null {
  if (uri === null) return null;
  // A bundled same-origin asset (e.g. the native ETH icon), never an arbitrary path.
  if (/^\/images\/[A-Za-z0-9/_-]+\.(svg|png|webp|jpe?g)$/.test(uri)) return uri;
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice('ipfs://'.length);
    return CID_PATH_PATTERN.test(cid) ? IPFS_GATEWAY + cid : null;
  }
  return isHttpUrl(uri) ? uri : null;
}
