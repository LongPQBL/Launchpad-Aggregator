'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" className="shrink-0">
      <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" className="shrink-0">
      <path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7Z" fill="currentColor" />
    </svg>
  );
}

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // Syncs with the no-FOUC inline script in layout.tsx, which may already have added 'dark' to
    // <html> before this component mounts — the initial render must stay false to match the
    // server-rendered HTML (document is undefined during SSR), so this can only be discovered
    // after mount, not via a lazy useState initializer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !isDark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
    setIsDark(next);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
