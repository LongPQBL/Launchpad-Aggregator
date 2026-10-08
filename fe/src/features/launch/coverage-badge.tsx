import { formatCoverageStatus } from '@/api/format';
import { Badge } from '@/components/ui/badge';

export interface CoverageBadgeProps {
  status: string;
}

const VARIANT_BY_STATUS: Record<string, 'default' | 'secondary' | 'destructive'> = {
  caught_up: 'default',
  backfilling: 'secondary',
  degraded: 'destructive',
};

export function CoverageBadge({ status }: CoverageBadgeProps) {
  if (status === 'backfilling') return null;

  return (
    <Badge data-testid="coverage-badge" data-status={status} variant={VARIANT_BY_STATUS[status] ?? 'secondary'}>
      {formatCoverageStatus(status)}
    </Badge>
  );
}
