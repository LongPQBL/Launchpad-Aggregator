'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ tabs, defaultValue }: { tabs: readonly TabItem[]; defaultValue?: string }) {
  const [active, setActive] = useState(defaultValue ?? tabs[0]?.value);
  const activeTab = tabs.find((tab) => tab.value === active) ?? tabs[0];
  return (
    <div>
      <div role="tablist" className="flex gap-4 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={tab.value === active}
            className={cn(
              'cursor-pointer border-b-2 px-1 pb-2 text-2xl ',
              tab.value === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActive(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="pt-4">{activeTab?.content}</div>
    </div>
  );
}
