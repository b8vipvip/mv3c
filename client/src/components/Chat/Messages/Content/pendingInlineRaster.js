/** 
 * Keep a partially streamed raster data URI out of the Markdown renderer.
 *
 * A model can append multiple `![...](data:image/png;base64,...)` blocks
 * during a single response. Inspect ALL blocks, not only the first one:
 * exposing a partial second/third base64 payload causes giant visible strings,
 * expensive Markdown parsing, and a broken gallery. A completed image and all
 * preceding text must remain visible while subsequent images are in flight.
 *
 * Only syntax of bounded raster image links is handled. This is a display
 * safeguard, not a way to authorize unsafe or oversized data URLs (that policy
 * belongs to inlineImageUrl / react-markdown).
 */

/** @param {string} content */
export function maskPendingInlineRasterImage(content) {
  const imageStart = /!\[[^\]\r\n]{0,1024}\]\(\s*data:image\/(?:png|jpeg|webp|gif);base64,/gi;
  let match;
  while ((match = imageStart.exec(content)) !== null) {
    // Valid base64 has no ')' byte; this closing parenthesis is the markdown
    // image terminator. Keep already-completed image blocks unmodified.
    const closedAt = content.indexOf(')', imageStart.lastIndex);
    if (closedAt < 0) {
      return content.slice(0, match.index) + '\n\n*图片正在接收…*';
    }
    imageStart.lastIndex = closedAt + 1;
  }
  return content;
}
