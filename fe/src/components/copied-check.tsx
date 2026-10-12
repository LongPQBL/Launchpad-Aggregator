// Shared "copied" confirmation: a small circle with a green border and a green check, shown in
// place of a copy icon (the copied text itself stays visible).
export function CopiedCheck({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-success text-success"
    >
      <svg viewBox="0 0 16 16" width={size - 6} height={size - 6} fill="none">
        <path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
