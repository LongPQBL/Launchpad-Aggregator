export function selectIndexerSourceIds(configured: readonly string[], selection: string | undefined): string[] {
  if (selection === undefined || selection.trim() === '') return [...configured];
  const requested = [...new Set(selection.split(',').map((id) => id.trim()).filter(Boolean))];
  const unknown = requested.filter((id) => !configured.includes(id));
  if (unknown.length) throw new Error(`Unknown indexer source: ${unknown.join(', ')}`);
  return requested;
}
