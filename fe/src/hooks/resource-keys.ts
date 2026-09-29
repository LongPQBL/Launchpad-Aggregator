export function chainResourceKey(chainId: number): string {
  return `chain:${chainId}`;
}

export function launchResourceKey(chainId: number, tokenAddress: string): string {
  return `launch:${chainId}:${tokenAddress.toLowerCase()}`;
}

export interface SseEventPayload {
  chainId: number;
  tokenAddress?: string;
}

export function matchesResourceKeys(payload: SseEventPayload, resourceKeys: readonly string[]): boolean {
  if (resourceKeys.includes(chainResourceKey(payload.chainId))) return true;
  if (payload.tokenAddress !== undefined) {
    return resourceKeys.includes(launchResourceKey(payload.chainId, payload.tokenAddress));
  }
  // A chain-wide event (no tokenAddress — e.g. a coverage-only change) still matters to any
  // launch-scoped subscriber on that chain, since it can affect that launch's coverage badge.
  const chainPrefix = `launch:${payload.chainId}:`;
  return resourceKeys.some((key) => key.startsWith(chainPrefix));
}
