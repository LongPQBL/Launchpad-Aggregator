'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

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
    <Button type="button" variant="ghost" size="sm" onClick={toggle} aria-label="Toggle dark theme">
      {isDark ? 'Light mode' : 'Dark mode'}
    </Button>
  );
}
