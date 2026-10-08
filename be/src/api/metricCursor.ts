export type LaunchSort = 'volume24hUsd' | 'recent' | 'fdvUsd' | 'tvlUsd' | 'change1h' | 'change1d';
export type SortDirection = 'asc' | 'desc';

export class InvalidMetricCursorError extends Error {}

interface MetricCursorValue {
  version: 1;
  sort: LaunchSort;
  direction: SortDirection;
  offset: number;
}

export function encodeMetricCursor(value: MetricCursorValue): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeMetricCursor(cursor: string, sort: LaunchSort, direction: SortDirection): MetricCursorValue {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error();
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || value.sort !== sort || value.direction !== direction
      || !Number.isSafeInteger(value.offset) || Number(value.offset) < 1 || Number(value.offset) > 10_000_000) throw new Error();
    return value as unknown as MetricCursorValue;
  } catch {
    throw new InvalidMetricCursorError('Invalid cursor');
  }
}
