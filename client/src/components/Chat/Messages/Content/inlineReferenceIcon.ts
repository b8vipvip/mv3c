/**
 * ChatGPT renders tiny source favicons inside citations. They are inline UI
 * markers, not 512px generated images or downloadable media. Accept only a
 * recognized, HTTPS favicon endpoint; do not proxy arbitrary model URLs.
 */
export function sourceFaviconDomain(src: string | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:' || url.hostname !== 'www.google.com'
      || url.pathname !== '/s2/favicons') return null;
    const domain = url.searchParams.get('domain') || '';
    const normalized = domain.startsWith('https://') || domain.startsWith('http://')
      ? new URL(domain).hostname.toLowerCase()
      : domain.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.length > 253
      || !normalized.includes('.')) return null;
    return normalized;
  } catch {
    return null;
  }
}
