'use client';

import { ShareMenu } from '@/components/share-menu';
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

export function HeaderActions({ twitterUrl }: HeaderActionsProps) {
  const iconButtonClass = 'flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground';

  return (
    <div className="flex items-center gap-1">
      {twitterUrl !== null && isHttpUrl(twitterUrl) && (
        <a href={twitterUrl} target="_blank" rel="noreferrer noopener" aria-label="X" className={iconButtonClass}>
          <TwitterIcon />
        </a>
      )}
      <ShareMenu buttonClassName={iconButtonClass} />
    </div>
  );
}
