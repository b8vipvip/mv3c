/** Allow only bounded raster image data from a model response as image sources.
 * react-markdown intentionally rejects data: links by default; do not widen
 * its protection for anchors, embedded HTML or SVG images.
 */
const RASTER_DATA_PREFIX = /^data:image\/(?:png|jpeg|webp|gif);base64,/i;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

export function isSafeRasterImageDataUrl(url: string): boolean {
  const match = RASTER_DATA_PREFIX.exec(url);
  if (!match) {
    return false;
  }
  const base64 = url.slice(match[0].length);
  return (
    base64.length > 0 &&
    base64.length <= MAX_BASE64_LENGTH &&
    base64.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  );
}
