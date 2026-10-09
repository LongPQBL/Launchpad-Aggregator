'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type SideFilter = 'buy' | 'sell';
export const SIDE_OPTIONS: readonly { value: SideFilter; label: string }[] = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
];

function UpDownIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M4.5 6.5 8 3l3.5 3.5" /><path d="M4.5 9.5 8 13l3.5-3.5" />
    </svg>
  );
}

// Every type starts selected; clicking an option toggles it. Deselecting everything is allowed and shows nothing.
export function TypeFilter({ selected, onChange }: { selected: readonly SideFilter[]; onChange: (values: SideFilter[]) => void }) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggle = (value: SideFilter) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <>
      <button ref={buttonRef} type="button" aria-haspopup="true" aria-expanded={open} aria-label="Filter by type"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setMenuPosition({ top: rect.bottom + 8, left: rect.left });
          setOpen((v) => !v);
        }}
        className="inline-flex cursor-pointer items-center gap-1.5 font-medium">
        <UpDownIcon />
        Type
      </button>
      {/* Portaled with fixed positioning: the table's overflow-x-auto container would otherwise clip the menu when the table is short (e.g. nothing selected). */}
      {open && menuPosition && createPortal(
        <div ref={menuRef} role="menu" aria-label="Type filter" style={{ top: menuPosition.top, left: menuPosition.left }} className="fixed z-50 w-40 rounded-lg border border-border bg-card p-1 text-foreground shadow-md">
          {SIDE_OPTIONS.map(({ value, label }) => (
            <button key={value} type="button" onClick={() => toggle(value)} aria-pressed={selected.includes(value)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm font-normal hover:bg-muted">
              {label} {selected.includes(value) && <TypeCheck />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function TypeCheck() {
  return (
    <span data-selected-check className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/20 text-brand">
      <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>
    </span>
  );
}
