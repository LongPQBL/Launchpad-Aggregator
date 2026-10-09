'use client';

import type { ReactNode } from 'react';
import { chainIcon, chainName } from '@/api/chains';

export function toggleValue<T>(selected: readonly T[], value: T): T[] {
  return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
}

export function ChevronIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SelectedCheck() {
  return <span data-selected-check className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-slate-900"><CheckIcon /></span>;
}

export function SelectionIcons({ values, icon }: { values: readonly (string | number)[]; icon: (value: string | number) => ReactNode }) {
  return (
    <span className="inline-flex items-center pl-1.5" aria-hidden="true">
      {values.slice(0, 3).map((value) => (
        <span key={value} className="-ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-background bg-muted text-[10px] font-semibold">
          {icon(value)}
        </span>
      ))}
      {values.length > 3 && (
        <span className="-ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-semibold">+{values.length - 3}</span>
      )}
    </span>
  );
}

export function ChainFilterIcon({ id }: { id: number }) {
  return chainIcon(id) ? (
    // eslint-disable-next-line @next/next/no-img-element -- fixed-size chain logo
    <img src={chainIcon(id)} alt="" width={20} height={20} className="h-5 w-5 rounded-full" />
  ) : <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase">{chainName(id).slice(0, 2)}</span>;
}

export function ChainFilter({ chainIds, selected, onChange, open, onToggle }: { chainIds: readonly number[]; selected: readonly number[]; onChange: (values: number[]) => void; open: boolean; onToggle: () => void }) {
  return (
    <nav aria-label="Filter by chain">
      <details name="launch-filters" open={open} className="group relative">
        <summary onClick={(event) => { event.preventDefault(); onToggle(); }} aria-label={selected.length ? `Selected chains: ${selected.map(chainName).join(', ')}` : 'All chains'} className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-input bg-transparent px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
          <SelectionIcons values={selected.length ? selected : chainIds.slice(0, 1)} icon={(value) => <ChainFilterIcon id={Number(value)} />} />
          <ChevronIcon />
        </summary>
        <div data-filter-menu className="absolute right-0 z-10 mt-2 max-h-[60vh] w-64 overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-md">
          <button type="button" onClick={() => onChange([])} aria-pressed={!selected.length} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
            All chains {!selected.length && <SelectedCheck />}
          </button>
          {chainIds.map((id) => (
            <button key={id} type="button" onClick={() => onChange(toggleValue(selected, id))} aria-pressed={selected.includes(id)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
              <span className="flex items-center gap-2">
                <ChainFilterIcon id={id} />
                {chainName(id)}
              </span>
              {selected.includes(id) && <SelectedCheck />}
            </button>
          ))}
        </div>
      </details>
    </nav>
  );
}
