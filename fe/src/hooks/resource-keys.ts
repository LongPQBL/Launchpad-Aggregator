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
  return payload.tokenAddress !== undefined && resourceKeys.includes(launchResourceKey(payload.chainId, payload.tokenAddress));
}
