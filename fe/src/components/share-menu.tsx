'use client';

import { useEffect, useRef, useState } from 'react';
import { CopiedCheck } from '@/components/copied-check';

function ShareIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="16" height="16" fill="none">
      <circle cx="12.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.5" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.5" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.1 7.1l5.8-3.1M5.1 8.9l5.8 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="16" height="16" fill="none" className="shrink-0">
      <path d="M6.7 9.3a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.3 6.7a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// Share button that opens a small popup with a "Copy link" row copying the current page URL
// (the launch or pool being viewed).
export function ShareMenu({ buttonClassName }: { buttonClassName: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const containerRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetRef.current) clearTimeout(resetRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  async function copyLink() {
    if (resetRef.current) clearTimeout(resetRef.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(window.location.href);
      setState('copied');
      resetRef.current = setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button type="button" aria-label="Share" aria-expanded={open} aria-haspopup="true" onClick={() => { setOpen(!open); setState('idle'); }} className={buttonClassName}>
        <ShareIcon />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 min-w-40 rounded-2xl border border-border bg-card p-1.5 shadow-lg">
          <button
            type="button"
            onClick={() => void copyLink()}
            aria-label={state === 'copied' ? 'Link copied' : 'Copy link'}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground hover:bg-foreground/5"
          >
            {state === 'copied' ? <CopiedCheck /> : <LinkIcon />}
            <span>Copy link</span>
          </button>
          {state === 'error' && <p role="alert" className="px-3 pb-1 text-xs text-destructive">Could not copy link</p>}
        </div>
      )}
    </div>
  );
}
