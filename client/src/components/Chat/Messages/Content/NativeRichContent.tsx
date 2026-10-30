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
    return (
      <div style={node.style as React.CSSProperties | undefined} className="min-w-0 max-w-full overflow-hidden">
        <ImagePreview imagePath={url} altText="生成图片"
          nativeLayout nativeObjectFit={node.style?.objectFit === 'cover' ? 'cover' : 'contain'} />
      </div>
    );
  }
  // React void elements cannot receive any children arguments; preserve
  // valid native <br>/<hr> instead of throwing and losing the whole reply.
  const props = {
    style: node.style as React.CSSProperties | undefined,
    className: 'min-w-0 max-w-full',
  };
  if (node.tag === 'br' || node.tag === 'hr') {
    return React.createElement(node.tag, props);
  }
  return React.createElement(node.tag, props, node.text, ...(children ?? []));
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
      {doc.files?.length ? (
        <div data-testid="mv3c-native-files" className="mt-3 flex flex-wrap gap-3">
          {doc.files.map(file => (
            <a
              key={file.url}
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="flex max-w-full min-w-0 items-center gap-3 rounded-xl border border-border-medium px-4 py-3 no-underline hover:bg-surface-secondary"
            >
              <span aria-hidden="true">📎</span>
              <span className="min-w-0 break-all text-sm">
                <span className="font-medium">{file.filename}</span>
                <span className="block text-xs text-text-secondary">
                  {file.status === 'processing'
                    ? '正在转存 · 如尚未完成请稍后重试'
                    : '下载文件'}
                  {file.bytes ? ' · ' + Math.ceil(file.bytes / 1024) + ' KB' : ''}
                </span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
