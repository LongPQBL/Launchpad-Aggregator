'use client';

import { useEffect, useRef, useState } from 'react';
import { isHttpUrl } from '@/api/url';

export interface HeaderActionsProps {
  twitterUrl: string | null;
}

function TwitterIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M18.9 1.2h3.7l-8.1 9.2L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9Zm-1.3 19.5h2.1L6.5 3.2H4.3l13.3 17.5Z" />
    </svg>
  );
}

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

export function HeaderActions({ twitterUrl }: HeaderActionsProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetRef.current) clearTimeout(resetRef.current);
  }, []);

  async function share() {
    if (resetRef.current) clearTimeout(resetRef.current);
    setCopyState('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(window.location.href);
      setCopyState('copied');
      resetRef.current = setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
    }
  }

  const iconButtonClass = 'flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground';

  return (
    <div className="flex items-center gap-1">
      {twitterUrl !== null && isHttpUrl(twitterUrl) && (
        <a href={twitterUrl} target="_blank" rel="noreferrer noopener" aria-label="X" className={iconButtonClass}>
          <TwitterIcon />
        </a>
      )}
      <button type="button" onClick={share} aria-label={copyState === 'copied' ? 'Link copied' : 'Share'} className={iconButtonClass}>
        <ShareIcon />
      </button>
      {copyState === 'error' && <span role="alert" className="text-xs text-destructive">Could not copy link</span>}
    </div>
  );
}
