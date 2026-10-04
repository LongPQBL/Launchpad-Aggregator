// websiteUrl/twitterUrl/logoUri all come from unverified onchain token metadata that the token
// creator controls — accept only http(s) with a real hostname, never data:/javascript:/relative.
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}
