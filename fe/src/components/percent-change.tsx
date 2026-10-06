import { formatPercent } from '@/api/format';
import { cn } from '@/lib/utils';

export function PercentChange({ value }: { value: string | null }) {
  const { text, className, direction } = formatPercent(value);
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {direction === 'up' && <span aria-hidden>▲</span>}
      {direction === 'down' && <span aria-hidden>▼</span>}
      {text}
    </span>
  );
}
