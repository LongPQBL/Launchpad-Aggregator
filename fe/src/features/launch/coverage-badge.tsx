import { formatCoverageStatus } from '@/api/format';

export interface CoverageBadgeProps {
  status: string;
}

export function CoverageBadge({ status }: CoverageBadgeProps) {
  return (
    <span data-testid="coverage-badge" data-status={status} className="rounded border border-border px-2 py-0.5 text-xs">
      {formatCoverageStatus(status)}
    </span>
  );
}
