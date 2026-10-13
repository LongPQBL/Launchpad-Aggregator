import type { SseEventPayload } from './resource-keys';

// A page opens a single SSE connection (LiveRefreshIndicator); components that can apply a cheaper
// partial update than a full router.refresh() listen for the same events through this window event
// instead of opening a second connection (the API caps open streams per client).
export const TRADE_CREATED_EVENT = 'launchpad:trade-created';

export function emitTradeCreated(payload: SseEventPayload): void {
  window.dispatchEvent(new CustomEvent<SseEventPayload>(TRADE_CREATED_EVENT, { detail: payload }));
}
