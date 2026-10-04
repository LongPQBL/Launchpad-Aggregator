import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './url';

describe('isHttpUrl', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com/path?x=1', true],
    ['https://x.com/example', true],
    ['data:text/html,<script>alert(1)</script>', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    ['relative/path', false],
    ['ftp://example.com', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(isHttpUrl(value)).toBe(expected);
  });
});
