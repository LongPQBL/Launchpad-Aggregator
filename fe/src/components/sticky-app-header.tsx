'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function StickyAppHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const updateHeight = () => {
      document.documentElement.style.setProperty('--app-header-height', `${header.getBoundingClientRect().height}px`);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--app-header-height');
    };
  }, []);

  return <header ref={headerRef} className={className}>{children}</header>;
}
