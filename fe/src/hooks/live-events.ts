import type { SseEventPayload } from './resource-keys';

// A page opens a single SSE connection (LiveRefreshIndicator); components that can apply a cheaper
// partial update than a full router.refresh() listen for the same events through this window event
// instead of opening a second connection (the API caps open streams per client).
export const TRADE_CREATED_EVENT = 'launchpad:trade-created';

// A swap landed in a pool (any protocol); the payload carries its poolId.
export const POOL_CHANGED_EVENT = 'launchpad:pool-changed';

export function emitPoolChanged(payload: SseEventPayload): void {
  window.dispatchEvent(new CustomEvent<SseEventPayload>(POOL_CHANGED_EVENT, { detail: payload }));
}

// A launch's stored figures (price, FDV, volume, ...) were recomputed after a trade, or a launch appeared or changed state.
export const LAUNCH_CHANGED_EVENT = 'launchpad:launch-changed';

export function emitLaunchChanged(payload: SseEventPayload): void {
  window.dispatchEvent(new CustomEvent<SseEventPayload>(LAUNCH_CHANGED_EVENT, { detail: payload }));
}

export function emitTradeCreated(payload: SseEventPayload): void {
  window.dispatchEvent(new CustomEvent<SseEventPayload>(TRADE_CREATED_EVENT, { detail: payload }));
}
