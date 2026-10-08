import { vi } from 'vitest';
import { encodeFunctionResult, type Abi, type Address, type Hex, type StateOverride } from 'viem';
import type { CallClient } from '../erc20-state-override';

export interface FakeCallRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  account?: Address;
  stateOverride?: StateOverride;
}

export function encodeResult(abi: Abi, functionName: string, value: any): { data: Hex } {
  return { data: encodeFunctionResult({ abi, functionName, result: value } as any) };
}

export function makeFakeClient(handler: (request: FakeCallRequest) => { data?: Hex } | Promise<{ data?: Hex }>) {
  const call = vi.fn(async (request: FakeCallRequest) => handler(request));
  return { call } as unknown as CallClient & { call: typeof call };
}
