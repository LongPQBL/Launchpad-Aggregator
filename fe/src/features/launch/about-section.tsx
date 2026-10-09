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

function Pill({ href, children, icon, dark = false }: {
  href: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm',
        dark ? 'border-white/20 bg-black text-white hover:bg-neutral-800' : 'border-border/50 bg-accent text-accent-foreground hover:bg-foreground/5',
      )}
    >
      {icon}
      {children}
    </a>
  );
}

function WebsiteIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.9 8h12.2M8 1.75c1.55 1.7 2.3 3.78 2.3 6.25S9.55 12.55 8 14.25C6.45 12.55 5.7 10.47 5.7 8S6.45 3.45 8 1.75Z" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function TwitterIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M18.9 1.2h3.7l-8.1 9.2L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9Zm-1.3 19.5h2.1L6.5 3.2H4.3l13.3 17.5Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <span aria-hidden className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none">
        <path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function ExplorerIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none">
      <path d="M9 2h5v5M14 2 7 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4H7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
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
            className={cn('whitespace-pre-wrap text-base text-muted-foreground', !expanded && 'line-clamp-3')}
          >
            {description}
          </p>
          {(canExpand || expanded) && (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="text-sm font-medium">
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
          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/20 bg-black px-3 py-1 text-sm text-white hover:bg-neutral-800"
        >
          <span>{`${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`}</span>
          {copyState === 'copied' ? <CopiedIcon /> : <CopyIcon />}
        </button>
        {copyState === 'error' && (
          <span role="alert" className="text-sm text-destructive">
            Could not copy automatically — select to copy: <span className="select-all break-all cursor-pointer">{tokenAddress}</span>
          </span>
        )}
        {explorerUrl !== undefined && <Pill href={explorerUrl} icon={<ExplorerIcon />} dark>{explorerLabel ?? 'Explorer'}</Pill>}
        {((websiteUrl !== null && isHttpUrl(websiteUrl)) || (twitterUrl !== null && isHttpUrl(twitterUrl))) && (
          <div className="flex flex-nowrap items-center gap-2">
            {websiteUrl !== null && isHttpUrl(websiteUrl) && <Pill href={websiteUrl} icon={<WebsiteIcon />} dark>Website</Pill>}
            {twitterUrl !== null && isHttpUrl(twitterUrl) && <Pill href={twitterUrl} icon={<TwitterIcon />} dark>Twitter</Pill>}
          </div>
        )}
      </div>
    </div>
  );
}
