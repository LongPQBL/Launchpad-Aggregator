import { isHttpUrl } from './url';

// IPFS logos are served by this app's own /api/logo (fetched once, shrunk and cached on the server: the public gateways take seconds per
// image and the files are often hundreds of kilobytes). Only a CID is accepted; the gateway URL itself is never built in the browser.
// A real CID (base32 or base58) is alphanumeric; an optional /subresource path may follow it.
// Rejects path traversal (`..`), query strings, and fragments.
const CID_PATH_PATTERN = /^[A-Za-z0-9]+(\/[^?#]*)?$/;
const GATEWAY_URL_PATTERN = /^https:\/\/gateway\.pinata\.cloud\/ipfs\/([A-Za-z0-9]+(?:\/[A-Za-z0-9._-]+)*)$/;

function logoProxyUrl(cid: string): string { return `/api/logo?c=${encodeURIComponent(cid)}`; }

export function resolveLogoUrl(uri: string | null): string | null {
  if (uri === null) return null;
  // A bundled same-origin asset (e.g. the native ETH icon), never an arbitrary path.
  if (/^\/images\/[A-Za-z0-9/_-]+\.(svg|png|webp|jpe?g)$/.test(uri)) return uri;
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice('ipfs://'.length);
    return CID_PATH_PATTERN.test(cid) && !cid.includes('..') ? logoProxyUrl(cid) : null;
  }
  // A launch that stored a Pinata gateway link is the same image as its CID.
  const gateway = GATEWAY_URL_PATTERN.exec(uri);
  if (gateway) return logoProxyUrl(gateway[1]!);
  return isHttpUrl(uri) ? uri : null;
}
