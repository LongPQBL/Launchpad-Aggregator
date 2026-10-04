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
});
