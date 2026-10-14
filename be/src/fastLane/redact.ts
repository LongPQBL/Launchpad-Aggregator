/** RPC URLs embed the provider key, and viem puts them in error messages: never print one. */
export function redactUrls(text: string): string {
  return text.replace(/(?:wss?|https?):\/\/[^\s"'`)>]*/gi, '[redacted-url]');
}

export function redactError(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}
