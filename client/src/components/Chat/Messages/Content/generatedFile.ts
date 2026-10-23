/** Chat2api archived generated files are download-only bearer URLs. */
const GENERATED_FILE_URL =
  /\/api\/generated-files\/gen_[A-Za-z0-9_-]{12,}\/[A-Za-z0-9_-]{12,}\/?$/;

export function generatedFileHref(href: string, securePage: boolean): string | null {
  try {
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    if (!GENERATED_FILE_URL.test(url.pathname)) {
      return null;
    }
    if (securePage && url.protocol === 'http:') {
      url.protocol = 'https:';
    }
    return url.href;
  } catch {
    return null;
  }
}
