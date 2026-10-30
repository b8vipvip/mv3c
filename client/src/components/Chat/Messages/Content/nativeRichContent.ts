/** Native presentation v1: never trust upstream HTML, script or arbitrary CSS. */
export type NativeNode = {
  tag: string;
  text?: string;
  media_index?: number;
  children?: NativeNode[];
  style?: Record<string, string>;
};
export type NativeFile = { filename: string; url: string; bytes: number; status: 'processing' | 'ready' | 'failed' };
export type NativeDocument = {
  version: 1; revision: number; root: NativeNode; assets: string[]; files?: NativeFile[];
};
const tags = new Set('div p span strong em h1 h2 h3 h4 ul ol li blockquote pre code table thead tbody tr td th figure figcaption img hr br'.split(' '));
const enums: Record<string, string[]> = {
  display: ['block','inline','inline-block','flex','inline-flex','grid'],
  flexDirection: ['row','row-reverse','column','column-reverse'],
  flexWrap: ['wrap','nowrap'], justifyContent: ['start','center','end','space-between','space-around'],
  alignItems: ['start','center','end','stretch','baseline'],
  objectFit: ['contain','cover','fill','none'],
  textAlign: ['left','center','right','justify','start','end'],
  fontWeight: ['400','500','600','700'],
};
const lengths = new Set(['gap','padding','marginTop','marginBottom','width','maxWidth','height','borderRadius','fontSize','lineHeight']);
const len = /^(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|rem|%))$/;
const colors = /^(?:#[0-9a-f]{3,8}|rgba?\([0-9.,\s]+\))$/i;
const cols = /^(?:\d{1,4}(?:\.\d{1,2})?(?:px|%)|minmax\(\d{1,4}(?:\.\d{1,2})?px,\s*1fr\)|1fr)(?:\s+(?:\d{1,4}(?:\.\d{1,2})?(?:px|%)|minmax\(\d{1,4}(?:\.\d{1,2})?px,\s*1fr\)|1fr)){0,5}$/;
export const isOwnedAsset = (url: unknown): url is string =>
  typeof url === 'string' &&
  /^https:\/\/[^/?#]+(?::[0-9]{1,5})?\/api\/media\/[a-zA-Z0-9_-]{6,100}\/[a-zA-Z0-9_-]{8,150}$/.test(url);

export const isOwnedGeneratedFile = (url: unknown): url is string =>
  typeof url === 'string' &&
  /^https:\/\/[^/?#]+(?::[0-9]{1,5})?\/api\/generated-files\/(?:pending\/pgen_[a-f0-9]{32}\/[a-zA-Z0-9_-]{16,150}|[a-zA-Z0-9_-]{6,100}\/[a-zA-Z0-9_-]{8,150})$/.test(url);

export function validateNativeContent(data: unknown): NativeDocument | null {
  if (!data || typeof data !== 'object') return null;
  const doc = data as Record<string, unknown>;
  if (doc.version !== 1 || typeof doc.revision !== 'number' ||
      !Number.isSafeInteger(doc.revision) || doc.revision < 1 ||
      !Array.isArray(doc.assets) || doc.assets.length > 40 ||
      !doc.assets.every(isOwnedAsset)) return null;
  // File descriptors come exclusively from the owned, post-archive
  // chat2api response. Unknown or malicious fields fail closed.
  if ('files' in doc && (!Array.isArray(doc.files) || doc.files.length > 10)) return null;
  const files: NativeFile[] = [];
  for (const item of (doc.files as unknown[] | undefined) ?? []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const f = item as Record<string, unknown>;
    if (Object.keys(f).some(key => !['filename', 'url', 'bytes', 'status'].includes(key)) ||
        typeof f.filename !== 'string' || f.filename.length < 1 ||
        f.filename.length > 180 || /[\x00-\x1f\x7f]/.test(f.filename) ||
        !isOwnedGeneratedFile(f.url) ||
        typeof f.bytes !== 'number' || !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0 || f.bytes > 24 * 1024 * 1024 ||
        !['processing', 'ready', 'failed'].includes(String(f.status)) ||
        files.some(existing => existing.url === f.url)) return null;
    files.push({ filename: f.filename, url: f.url, bytes: f.bytes,
      status: f.status as NativeFile['status'] });
  }
  let count = 0, total = 0, images = 0;
  const check = (input: unknown, depth: number): NativeNode | null => {
    if (!input || typeof input !== 'object' || depth > 14 || ++count > 1200) return null;
    const n = input as Record<string, unknown>;
    if (typeof n.tag !== 'string' || !tags.has(n.tag) ||
        Object.keys(n).some(k => !['tag','text','children','style','media_index'].includes(k))) return null;
    const node: NativeNode = { tag: n.tag };
    if (n.tag === 'img') {
      if (!Number.isInteger(n.media_index) || (n.media_index as number) !== images ||
          images >= (doc.assets as unknown[]).length ||
          'text' in n || 'children' in n) return null;
      node.media_index = images++;
    } else if ('media_index' in n) return null;
    if ('text' in n) {
      if (typeof n.text !== 'string' || (total += n.text.length) > 96000) return null;
      node.text = n.text;
    }
    if (n.style != null) {
      if (!n.style || typeof n.style !== 'object' || Array.isArray(n.style)) return null;
      const inputStyle = n.style as Record<string, unknown>;
      if (Object.keys(inputStyle).length > 18) return null;
      const styles: Record<string,string> = {};
      for (const [k,v] of Object.entries(inputStyle)) {
        if (typeof v !== 'string') return null;
        if ((enums[k]?.includes(v)) ||
            (lengths.has(k) && v.length <= 16 && len.test(v)) ||
            (['color','backgroundColor'].includes(k) && v.length <= 48 && colors.test(v)) ||
            (k === 'gridTemplateColumns' && v.length <= 120 && cols.test(v))) styles[k] = v;
        else return null;
      }
      node.style = styles;
    }
    if ('children' in n) {
      if (!Array.isArray(n.children) || n.children.length > 80 ||
          ['img','hr','br'].includes(n.tag)) return null;
      const children: NativeNode[] = [];
      for (const child of n.children) {
        const safe = check(child,depth+1);
        if (!safe) return null;
        children.push(safe);
      }
      node.children = children;
    }
    return node;
  };
  const root = check(doc.root,0);
  // Native image ordinals must match the *archived* image count exactly.
  // Otherwise the server response may contain decorative/older images:
  // fall back to canonical Markdown rather than show the wrong picture.
  return root && images === doc.assets.length ? {
    version: 1, revision: doc.revision, root, assets: doc.assets as string[],
    ...(files.length || 'files' in doc ? { files } : {}),
  } : null;
}

/** Archive readiness may change after the last DOM revision. A same-revision
 * verified asset update is observable without accepting stale content. */
export function shouldApplyNativeSnapshot(
  previous: NativeDocument | null,
  next: NativeDocument,
): boolean {
  if (!previous) return true;
  if (next.revision !== previous.revision) return next.revision > previous.revision;
  // The same DOM revision may gain media/file readiness, but cannot lose
  // already verified assets or regress a completed archive to "processing".
  // An out-of-order initial GET must not undo a later SSE ready event.
  const oldFiles = previous.files ?? [], newFiles = next.files ?? [];
  if (newFiles.length < oldFiles.length) return false;
  if (oldFiles.some(oldFile =>
    oldFile.status !== 'processing' &&
    newFiles.some(newFile =>
      newFile.url === oldFile.url && newFile.status === 'processing'))) return false;
  if (next.assets.length < previous.assets.length) return false;
  if (next.assets.length !== previous.assets.length) return true;
  if (next.assets.some((asset, index) => asset !== previous.assets[index])) return true;
  if (oldFiles.length !== newFiles.length) return true;
  return newFiles.some((file, index) =>
    file.url !== oldFiles[index].url || file.status !== oldFiles[index].status);
}

/**
 * Native-rich v1 serializes visual text/images but intentionally omits <a>
 * targets and file-card actions. Never replace the canonical Markdown while
 * it contains an actionable link: that would silently hide verified download
 * URLs (XLSX/PPTX/ZIP), citations or ordinary hyperlinks.
 *
 * Markdown images are excluded: their native img+MediaArchive mapping already
 * has a safe click/preview path. A future explicit native link/file schema
 * can lift this conservative fallback.
 */
export function hasUnrepresentedNativeLinks(text: string, native?: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  // Only remove links that exactly match *both* canonical Markdown and the
  // server-authenticated native file manifest. Never trust URL-shaped text.
  const owned = validateNativeContent(native)?.files ?? [];
  const used = new Set<string>();
  const remaining = text.replace(
    /\[📎 ([^\]\n]{1,180})\]\((https?:\/\/[^\s)]+)\)/g,
    (match, label: string, url: string) => {
      // The backend may safely promote an HTTP same-host archive URL to
      // the provider's validated HTTPS origin; preserve the exact file match.
      const file = owned.find(f => (f.url === url ||
        (url.startsWith('http://') && f.url === 'https://' + url.slice(7))) &&
        f.filename.replace(/[\[\]]/g, '') === label);
      if (!file || used.has(url)) return match;
      used.add(url);
      return '';
    },
  );
  if (used.size !== owned.length ||
      /\/api\/generated-files\/[A-Za-z0-9_-]{6,}/.test(remaining)) return true;
  const markdownLink = /(^|[^!])\[[^\]\n]{1,256}\]\(\s*<?(?:https?:\/\/|\/|sandbox:)[^\s)>]{1,2048}>?\s*\)/m;
  // GFM autolinks bare URLs. Strip Markdown images first so an image-only
  // response still benefits from native image grouping and full-size preview.
  const withoutImages = remaining.replace(/!\[[^\]\n]{0,256}\]\(\s*<?[^)\n]{1,2048}>?\s*\)/g, '');
  return markdownLink.test(remaining) ||
    /(?:https?:\/\/[^\s<>)]{1,2048}|\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.test(withoutImages);
}


/**
 * The native sidecar is presentational, not a replacement authority. Older
 * Workers may produce schema-valid partial layouts after hitting the v1
 * node/character budget. A substantially longer canonical answer wins.
 * Markdown table punctuation, math syntax and code fences explain some
 * length differences, so use a conservative threshold.
 */
export function hasNativeTextCoverage(data: unknown, canonical: string): boolean {
  if (!canonical || canonical.length < 700) return true;
  const doc = validateNativeContent(data);
  if (!doc) return false;
  const canonicalText = canonical
    .replace(/!\[[^\]\n]{0,256}\]\([^)\n]{1,2048}\)/g, '')
    .replace(/\[([^\]\n]{1,256})\]\([^)\n]{1,2048}\)/g, '$1')
    .replace(/[#*_~>|\\{}[\]]/g, ' ')
    .replace(/\x60/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (canonicalText.length < 600) return true;
  let nativeText = '';
  const visit = (node: NativeNode): void => {
    if (node.text) nativeText += node.text + ' ';
    node.children?.forEach(visit);
  };
  visit(doc.root);
  const renderedLength = nativeText.replace(/\s+/g, ' ').trim().length;
  return renderedLength >= canonicalText.length * 0.65;
}


/** A per-mounted-message presentation key. Changing account, chat or message
 * invalidates a previously cached native document before effects re-run. */
export function nativeMessageScopeKey(
  token?: string, conversationId?: string, messageId?: string,
): string {
  return JSON.stringify([token ?? null, conversationId ?? null, messageId ?? null]);
}

/** The retry budget starts at the first *observed* pending file, not at the
 * beginning of a potentially 900-second upstream generation. */
export function canRetryNativePendingFile(
  firstProcessingAt: number | null, now: number,
): boolean {
  return firstProcessingAt !== null &&
    now >= firstProcessingAt && now - firstProcessingAt < 8 * 60 * 1000;
}
