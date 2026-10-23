/**
 * chat2api serves generated raster originals and independent lightweight previews
 * from /api/media/med_<id>/<token>. Never rewrite arbitrary external images.
 */
const OWNED_MEDIA_PATH = /^\/api\/media\/med_[A-Za-z0-9_-]{12,}\/[A-Za-z0-9_-]{12,}(?:\/thumbnail)?$/;

export function chat2apiMediaUrls(
  input: string,
  securePage: boolean,
): { preview: string; original: string } {
  const fallback = { preview: input, original: input.replace(/\/thumbnail(?=[?#]|$)/, '') };
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return fallback;
    }
    if (!OWNED_MEDIA_PATH.test(url.pathname)) {
      return fallback;
    }
    // HTTPS mv3c must not embed a plaintext upstream image or download link.
    if (securePage && url.protocol === 'http:') {
      url.protocol = 'https:';
    }
    url.pathname = url.pathname.replace(/\/thumbnail$/, '');
    const original = url.href;
    url.pathname += '/thumbnail';
    return { preview: url.href, original };
  } catch {
    // Relative paths and data: URLs use their previous resolution behavior.
    return fallback;
  }
}
