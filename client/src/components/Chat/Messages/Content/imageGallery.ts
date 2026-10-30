/**
 * Identify a run of standalone Markdown images without guessing from natural
 * image dimensions. The Worker currently serializes a source gallery into
 * adjacent ![](url) markers, possibly separated by paragraph boundaries.
 *
 * Only HTTPS and root-relative paths are accepted. Everything else stays in
 * the existing react-markdown pipeline with its strict URL policy.
 */
export type GalleryImage = { src: string; alt: string };
export type GalleryBlock<T> = { key: string; raw: string; value: T };
export type GallerySegment<T> =
  | { type: 'block'; block: GalleryBlock<T> }
  | { type: 'gallery'; key: string; images: GalleryImage[] };

export function standaloneImages(raw: string): GalleryImage[] {
  const matches: GalleryImage[] = [];
  const image = /!\[([^\]\r\n]{0,160})\]\((https:\/\/[^\s)]+|\/(?:api\/|images\/|uploads\/)[^\s)]+)\)/g;
  const remaining = raw.replace(image, (_whole, alt: string, src: string) => {
    matches.push({ alt: alt || '图片', src });
    return '';
  });
  // Empty/partial fences and unknown prose must not be converted to galleries.
  return matches.length && matches.length <= 8 && !remaining.trim() ? matches : [];
}

export function groupImageBlocks<T>(blocks: GalleryBlock<T>[]): GallerySegment<T>[] {
  const segments: GallerySegment<T>[] = [];
  let run: GalleryBlock<T>[] = [];
  let images: GalleryImage[] = [];
  const flush = () => {
    if (images.length >= 2) {
      segments.push({ type: 'gallery', key: 'gallery-' + run[0].key, images });
    } else {
      for (const block of run) segments.push({ type: 'block', block });
    }
    run = []; images = [];
  };
  for (const block of blocks) {
    const standalone = standaloneImages(block.raw);
    if (!standalone.length || images.length + standalone.length > 8) {
      flush();
      segments.push({ type: 'block', block });
      continue;
    }
    run.push(block);
    images.push(...standalone);
  }
  flush();
  return segments;
}
