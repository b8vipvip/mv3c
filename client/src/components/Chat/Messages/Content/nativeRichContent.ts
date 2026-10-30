/** Native presentation v1: never trust upstream HTML, script or arbitrary CSS. */
export type NativeNode = {
  tag: string;
  text?: string;
  media_index?: number;
  children?: NativeNode[];
  style?: Record<string, string>;
};
export type NativeDocument = { version: 1; revision: number; root: NativeNode; assets: string[] };
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
const cols = /^(?:\d{1,3}(?:px|%)|minmax\(\d{1,3}px,\s*1fr\)|1fr)(?:\s+(?:\d{1,3}(?:px|%)|minmax\(\d{1,3}px,\s*1fr\)|1fr)){0,5}$/;
export const isOwnedAsset = (url: unknown): url is string =>
  typeof url === 'string' &&
  /^https:\/\/[^/?#]+(?::[0-9]{1,5})?\/api\/media\/[a-zA-Z0-9_-]{6,100}\/[a-zA-Z0-9_-]{8,150}$/.test(url);

export function validateNativeContent(data: unknown): NativeDocument | null {
  if (!data || typeof data !== 'object') return null;
  const doc = data as Record<string, unknown>;
  if (doc.version !== 1 || typeof doc.revision !== 'number' ||
      !Number.isSafeInteger(doc.revision) || doc.revision < 1 ||
      !Array.isArray(doc.assets) || doc.assets.length > 40 ||
      !doc.assets.every(isOwnedAsset)) return null;
  let count = 0, total = 0, images = 0;
  const check = (input: unknown, depth: number): NativeNode | null => {
    if (!input || typeof input !== 'object' || depth > 14 || ++count > 420) return null;
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
      if (typeof n.text !== 'string' || (total += n.text.length) > 48000) return null;
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
  if (next.assets.length !== previous.assets.length) return true;
  return next.assets.some((asset, index) => asset !== previous.assets[index]);
}
