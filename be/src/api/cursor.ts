export interface CursorValue { blockNumber: bigint; txHash: string; logIndex: number }

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify([value.blockNumber.toString(), value.txHash.toLowerCase(), value.logIndex])).toString('base64url');
}

export function decodeCursor(value: string): CursorValue {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string'
      || !/^\d+$/.test(parsed[0]) || typeof parsed[1] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(parsed[1])
      || !Number.isSafeInteger(parsed[2]) || parsed[2] < 0) throw new Error('Invalid cursor');
    return { blockNumber: BigInt(parsed[0]), txHash: parsed[1].toLowerCase(), logIndex: parsed[2] };
  } catch {
    throw new Error('Invalid cursor');
  }
}
