'use client';

import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

// Hand-rolled, not Radix — this app has no dialog/overlay primitive yet and the rest of the UI
// kit (Tabs, Badge, Button) is already plain Tailwind rather than a headless-UI dependency.
export function Dialog({ open, onClose, title, children }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div role="dialog" aria-modal="true" aria-label={title} className={cn(
        'relative z-10 w-full max-w-sm rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xl',
      )}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
              <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
