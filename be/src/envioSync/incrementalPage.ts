import type { Pool } from 'pg';
import type { CursorPosition } from './incrementalCursor.js';

export interface RawPage {
  rows: Record<string, unknown>[];
  /** The last row's position, for the caller's next `after`; `null` when the page is empty. */
  lastPosition: CursorPosition | null;
}

export interface ReadRawPageInput {
  table: string;
  chainId: number;
  after: CursorPosition;
  fence: bigint;
  limit: number;
}

// Postgres cannot parameterize an identifier, so `table` is interpolated directly — this validates
// its shape (`schema."Entity"`, optionally quoting the schema) before that happens, rejecting anything
// with the characters needed to break out of an identifier (quotes, semicolons, whitespace, comments).
// A production caller only ever passes one of Envio's real `envio."RawX"` entity tables; the pattern
// also accepts a disposable fixture schema name (e.g. `envio_fixture_cursor."RawTestEvent"`) so tests
// can stand in for Envio's own Postgres without widening what counts as safe.
const SAFE_TABLE_PATTERN = /^"?[A-Za-z_][A-Za-z0-9_]*"?\."?[A-Za-z_][A-Za-z0-9_]*"?$/;

function assertSafeTable(table: string): void {
  if (!SAFE_TABLE_PATTERN.test(table)) {
    throw new Error(`Unsafe or unrecognized raw table identifier: ${table}`);
  }
}

/** Point lookup by Envio's own `id`, for retrying one unresolved row — see unresolvedEvents.ts. */
export async function readRawRowById(envioPool: Pool, table: string, id: string): Promise<Record<string, unknown> | null> {
  assertSafeTable(table);
  const result = await envioPool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Reads the next bounded page of an Envio raw-event table in strict (blockNumber, logIndex, id)
 * order, never past `fence` — the pass's own observed Envio-processed block. Ties on
 * (blockNumber, logIndex) break on `id` so pagination can never skip or duplicate a row.
 */
export async function readRawPage(envioPool: Pool, input: ReadRawPageInput): Promise<RawPage> {
  assertSafeTable(input.table);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
    throw new Error(`Invalid raw page limit: ${input.limit}`);
  }
  const result = await envioPool.query(
    `SELECT * FROM ${input.table}
     WHERE "chainId" = $1
       AND "blockNumber" <= $2
       AND (
         "blockNumber" > $3
         OR ("blockNumber" = $3 AND "logIndex" > $4)
         OR ("blockNumber" = $3 AND "logIndex" = $4 AND id > $5)
       )
     ORDER BY "blockNumber" ASC, "logIndex" ASC, id ASC
     LIMIT $6`,
    [input.chainId, input.fence.toString(), input.after.blockNumber.toString(), input.after.logIndex, input.after.rawId, input.limit],
  );
  const rows = result.rows as Record<string, unknown>[];
  const last = rows[rows.length - 1];
  const lastPosition: CursorPosition | null = last
    ? { blockNumber: BigInt(String(last.blockNumber)), logIndex: Number(last.logIndex), rawId: String(last.id) }
    : null;
  return { rows, lastPosition };
}
