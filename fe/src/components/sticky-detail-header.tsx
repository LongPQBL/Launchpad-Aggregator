'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function StickyDetailHeader({ children, className }: { children: ReactNode; className?: string }) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const updateCompactState = () => {
      const top = headerRef.current?.getBoundingClientRect().top;
      const headerHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-header-height')) || 60;
      setCompact(top !== undefined && top <= headerHeight);
    };

    updateCompactState();
    window.addEventListener('scroll', updateCompactState, { passive: true });
    window.addEventListener('resize', updateCompactState);
    return () => {
      window.removeEventListener('scroll', updateCompactState);
      window.removeEventListener('resize', updateCompactState);
    };
  }, []);

  return (
    <div
      ref={headerRef}
      data-compact={compact}
      style={{ top: 'var(--app-header-height, 60px)' }}
      className={cn('group sticky z-40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80', className)}
    >
      {children}
    </div>
  );
}
