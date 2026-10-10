import type { ReactNode } from 'react';

// The heading row shared by the Pools and Transactions pages. It has a fixed height (the chain-filter pill sets the
// tallest content) so the table below starts at the same place on both pages when switching between them.
export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-10 items-center justify-between gap-3">
      {title ? <h1 className="text-2xl">{title}</h1> : <span />}
      {children}
    </div>
  );
}
