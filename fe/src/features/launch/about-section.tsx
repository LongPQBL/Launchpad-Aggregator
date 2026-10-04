'use client';

import { useEffect, useRef, useState } from 'react';
import { isHttpUrl } from '@/api/url';
import { cn } from '@/lib/utils';

export interface AboutSectionProps {
  description: string | null;
  tokenAddress: string;
  explorerUrl: string;
  websiteUrl: string | null;
  twitterUrl: string | null;
}

function Pill({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="rounded-full bg-accent px-3 py-1 text-sm text-accent-foreground hover:bg-accent/80"
    >
      {children}
    </a>
  );
}

export function AboutSection({ description, tokenAddress, explorerUrl, websiteUrl, twitterUrl }: AboutSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  async function copyAddress() {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    setCopyState('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(tokenAddress);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <div className="flex flex-col gap-3">
      {description !== null && (
        <div>
          <p className={cn('whitespace-pre-wrap text-sm text-muted-foreground', !expanded && 'line-clamp-3')}>{description}</p>
          <button type="button" onClick={() => setExpanded((value) => !value)} className="text-sm font-medium text-primary hover:underline">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copyAddress}
          aria-label={copyState === 'copied' ? 'Copied' : 'Copy token address'}
          className="rounded-full bg-accent px-3 py-1 text-sm text-accent-foreground hover:bg-accent/80"
        >
          {copyState === 'copied' ? 'Copied' : `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`}
        </button>
        {copyState === 'error' && (
          <span role="alert" className="text-sm text-destructive">
            Could not copy automatically — select to copy: <span className="select-all font-mono">{tokenAddress}</span>
          </span>
        )}
        <Pill href={explorerUrl}>Robinhood Explorer</Pill>
        {websiteUrl !== null && isHttpUrl(websiteUrl) && <Pill href={websiteUrl}>Website</Pill>}
        {twitterUrl !== null && isHttpUrl(twitterUrl) && <Pill href={twitterUrl}>Twitter</Pill>}
      </div>
    </div>
  );
}
