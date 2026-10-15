import { describe, expect, it } from 'vitest';
import { resolveLogoUrl } from './ipfs.js';

describe('resolveLogoUrl', () => {
  it('resolves an ipfs:// URI through the app\'s own logo proxy, never straight to a gateway', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu'))
      .toBe('/api/logo?c=bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu');
  });

  it('treats a stored Pinata gateway link as the same image as its CID', () => {
    expect(resolveLogoUrl('https://gateway.pinata.cloud/ipfs/Qmb8rr5dz47bBRWq3QfPtnonnzYu6Bn7hJpqBCqg8jj9gs'))
      .toBe('/api/logo?c=Qmb8rr5dz47bBRWq3QfPtnonnzYu6Bn7hJpqBCqg8jj9gs');
  });

  it('passes a non-ipfs:// URL through unchanged', () => {
    expect(resolveLogoUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
  });

  it('returns null for a null input', () => {
    expect(resolveLogoUrl(null)).toBeNull();
  });

  it('resolves an ipfs:// URI with a trailing subresource path', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu/logo.png'))
      .toBe('/api/logo?c=bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu%2Flogo.png');
  });

  it('falls back to the placeholder for a CID with path-traversal characters', () => {
    expect(resolveLogoUrl('ipfs://../etc/passwd')).toBeNull();
  });

  it('falls back to the placeholder for a CID with a query string', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu?x=1')).toBeNull();
  });

  it('accepts a bundled /images asset but not a traversal or an arbitrary path', () => {
    expect(resolveLogoUrl('/images/tokens/eth.svg')).toBe('/images/tokens/eth.svg');
    expect(resolveLogoUrl('/images/../secret.svg')).toBeNull();
    expect(resolveLogoUrl('/etc/passwd')).toBeNull();
  });
});
