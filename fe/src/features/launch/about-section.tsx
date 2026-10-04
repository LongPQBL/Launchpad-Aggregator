'use client';

import { useState } from 'react';
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
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    await navigator.clipboard.writeText(tokenAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          aria-label={copied ? 'Copied' : 'Copy token address'}
          className="rounded-full bg-accent px-3 py-1 text-sm text-accent-foreground hover:bg-accent/80"
        >
          {copied ? 'Copied' : `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`}
        </button>
        <Pill href={explorerUrl}>Robinhood Explorer</Pill>
        {websiteUrl !== null && <Pill href={websiteUrl}>Website</Pill>}
        {twitterUrl !== null && <Pill href={twitterUrl}>Twitter</Pill>}
      </div>
    </div>
  );
}
