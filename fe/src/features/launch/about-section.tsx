'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isHttpUrl } from '@/api/url';
import { cn } from '@/lib/utils';

export interface AboutSectionProps {
  description: string | null;
  tokenAddress: string;
  explorerUrl?: string;
  explorerLabel?: string;
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

export function AboutSection({ description, tokenAddress, explorerUrl, explorerLabel, websiteUrl, twitterUrl }: AboutSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const hasDescription = description !== null && description.trim() !== '';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!hasDescription || expanded) return;
    const node = paragraphRef.current;
    if (!node) return;
    const measure = () => setCanExpand(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [description, hasDescription, expanded]);

  async function copyAddress() {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    setCopyState('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(tokenAddress);
      setCopyState('copied');
      // Only the transient success state auto-dismisses. A failure's fallback (the full address,
      // selectable for manual copying) must stay up until the next attempt — a 2s disappearance
      // would cut off a user mid-selection, especially a mobile long-press (final review, Important 1).
      copyResetRef.current = setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {hasDescription && (
        <div>
          <p
            ref={paragraphRef}
            className={cn('whitespace-pre-wrap text-sm text-muted-foreground', !expanded && 'line-clamp-3')}
          >
            {description}
          </p>
          {(canExpand || expanded) && (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="text-sm font-medium text-primary hover:underline">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
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
            Could not copy automatically — select to copy: <span className="select-all break-all font-mono">{tokenAddress}</span>
          </span>
        )}
        {explorerUrl !== undefined && <Pill href={explorerUrl}>{explorerLabel ?? 'Explorer'}</Pill>}
        {websiteUrl !== null && isHttpUrl(websiteUrl) && <Pill href={websiteUrl}>Website</Pill>}
        {twitterUrl !== null && isHttpUrl(twitterUrl) && <Pill href={twitterUrl}>Twitter</Pill>}
      </div>
    </div>
  );
}
