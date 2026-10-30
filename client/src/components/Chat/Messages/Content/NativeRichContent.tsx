import React, { useMemo } from 'react';
import ImagePreview from './Image';
import { validateNativeContent } from './nativeRichContent';
import type { NativeNode, NativeDocument } from './nativeRichContent';

function NativeElement({ node, doc }: { node: NativeNode; doc: NativeDocument }): React.ReactElement {
  const children = node.children?.map((child, i) => (
    <NativeElement key={i} node={child} doc={doc} />
  ));
  if (node.tag === 'img') {
    const url = doc.assets[node.media_index ?? -1];
    // Asset source has already passed the exact owned-media URL check.
    return <ImagePreview imagePath={url} altText="生成图片"
      compactGallery className="!mt-0 !shadow-none" />;
  }
  return React.createElement(
    node.tag,
    { style: node.style as React.CSSProperties | undefined,
      className: 'min-w-0 max-w-full' },
    node.text,
    children,
  );
}
/** Read-only element renderer. Does not use dangerouslySetInnerHTML, iframe
 * scripts, runtime CSS injection, or execute any event handlers from source.
 * If a stream is incomplete or the schema/assets do not match, use Markdown.
 */
export default function NativeRichContent({
  data, fallback,
}: { data: unknown; fallback: React.ReactNode }) {
  const doc = useMemo(() => validateNativeContent(data), [data]);
  if (!doc) return <>{fallback}</>;
  return (
    <div data-testid="mv3c-native-rich-content" className="w-full min-w-0 max-w-full overflow-x-auto">
      <NativeElement node={doc.root} doc={doc} />
    </div>
  );
}
