import { describe, expect, it } from 'vitest';
import { resolveLogoUrl } from './ipfs.js';

describe('resolveLogoUrl', () => {
  it('resolves an ipfs:// URI through the Pinata gateway', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu'))
      .toBe('https://gateway.pinata.cloud/ipfs/bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu');
  });

  it('passes a non-ipfs:// URL through unchanged', () => {
    expect(resolveLogoUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
  });

  it('returns null for a null input', () => {
    expect(resolveLogoUrl(null)).toBeNull();
  });

  it('resolves an ipfs:// URI with a trailing subresource path', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu/logo.png'))
      .toBe('https://gateway.pinata.cloud/ipfs/bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu/logo.png');
  });

  it('falls back to the placeholder for a CID with path-traversal characters', () => {
    expect(resolveLogoUrl('ipfs://../etc/passwd')).toBeNull();
  });

  it('falls back to the placeholder for a CID with a query string', () => {
    expect(resolveLogoUrl('ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu?x=1')).toBeNull();
  });
});
