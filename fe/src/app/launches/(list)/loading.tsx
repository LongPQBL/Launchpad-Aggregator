import { LaunchList } from '@/features/launches/launch-list';

// The real toolbar and column header are shown as-is; only the rows are placeholders, so nothing shifts when the data arrives.
export default function Loading() {
  return <LaunchList page={{ items: [], nextCursor: null }} sources={[]} error={false} loading />;
}
