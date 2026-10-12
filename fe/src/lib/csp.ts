export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Extra origins the browser itself calls (backend API, chain RPC, paymaster). Invalid URLs are ignored. */
  connectUrls: readonly (string | undefined)[];
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

// Strict, nonce-based policy: only scripts carrying this request's nonce (and what they load) may run, so an injected
// <script> or inline handler is refused even if some token name or description ever slipped past React's escaping.
export function buildContentSecurityPolicy({ nonce, isDev, connectUrls }: CspOptions): string {
  const connect = new Set(["'self'"]);
  for (const url of connectUrls) { const origin = originOf(url); if (origin) connect.add(origin); }
  if (isDev) { connect.add('ws:'); connect.add('http:'); }
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonced Next.js bootstrap load its own chunks; 'unsafe-eval' is only for React's dev tooling.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // UI libraries inject <style> tags and style="" attributes at runtime, which a nonce cannot cover. Inline CSS cannot run
    // code, so this is the usual trade-off; the script-src above is what stops injected code.
    "style-src 'self' 'unsafe-inline'",
    // Token logos are arbitrary https (and IPFS gateway) images chosen by token creators.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}
