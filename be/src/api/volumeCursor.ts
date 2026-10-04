import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VolumeCursorValue {
  version: 1; sort: 'volume24hUsd'; asOf: number; rankCategory: 'positive' | 'zero' | 'null';
  rankValue: string | null; tiebreakBlockNumber: string; tiebreakTxHash: string; tiebreakLogIndex: number;
}

const MAX_CURSOR_AGE_SECONDS = 24 * 3600;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeVolumeCursor(value: VolumeCursorValue, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeVolumeCursor(value: string, secret: string, now: number): VolumeCursorValue {
  try {
    const [payload, signature] = value.split('.');
    if (!payload || !signature) throw new Error('Invalid cursor');
    const expected = sign(payload, secret);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid cursor');
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid cursor');
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || candidate.sort !== 'volume24hUsd') throw new Error('Invalid cursor');
    if (typeof candidate.asOf !== 'number' || !Number.isSafeInteger(candidate.asOf)) throw new Error('Invalid cursor');
    if (now - candidate.asOf > MAX_CURSOR_AGE_SECONDS) throw new Error('Invalid cursor');
    if (candidate.rankCategory !== 'positive' && candidate.rankCategory !== 'zero' && candidate.rankCategory !== 'null') throw new Error('Invalid cursor');
    if (typeof candidate.tiebreakBlockNumber !== 'string' || typeof candidate.tiebreakTxHash !== 'string' || typeof candidate.tiebreakLogIndex !== 'number') {
      throw new Error('Invalid cursor');
    }
    return candidate as unknown as VolumeCursorValue;
  } catch {
    throw new Error('Invalid cursor');
  }
}
