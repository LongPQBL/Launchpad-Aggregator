// PostgreSQL's extended query protocol allows at most 65,535 bound parameters per statement (an
// int16 wire-protocol field). A single multi-row INSERT built from one job's whole batch (up to
// 2,000 blocks of real trade volume) can exceed that — found live: pons-v1-active-trades failed with
// "bind message has N parameter formats but 0 parameters" once one window's trade count times its
// 18 columns passed 65,535. Splits rows into chunks that each stay under the limit.
const MAX_BIND_PARAMETERS = 65_535;

export function chunkForInsert<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  if (!Number.isSafeInteger(columnsPerRow) || columnsPerRow < 1) throw new Error('Invalid column count');
  const rowsPerChunk = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columnsPerRow));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += rowsPerChunk) chunks.push(rows.slice(index, index + rowsPerChunk));
  return chunks;
}
