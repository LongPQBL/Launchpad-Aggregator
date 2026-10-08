import { afterEach, describe, expect, it } from 'vitest';
import { themeInitScript } from './theme-init-script';

function run() {
  new Function(themeInitScript)();
}

describe('themeInitScript', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
  });

  it('defaults to dark when nothing is stored', () => {
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('stays dark when the stored theme is dark', () => {
    localStorage.setItem('theme', 'dark');
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('opts out of dark when the stored theme is light', () => {
    localStorage.setItem('theme', 'light');
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
