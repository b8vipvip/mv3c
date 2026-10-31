import React, { useMemo } from 'react';
import ImagePreview from './Image';
import { validateNativeContent } from './nativeRichContent';
import type { NativeNode, NativeDocument, NativeFile } from './nativeRichContent';

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
function NativeGeneratedFile({ file }: { file: NativeFile }): React.ReactElement {
  const ready = file.status === 'ready';
  const card = (
    <>
      <span aria-hidden="true">📎</span>
      <span className="min-w-0 break-all text-sm">
        <span className="font-medium">{file.filename}</span>
        <span className="block text-xs text-text-secondary">
          {ready ? '下载文件'
            : file.status === 'failed' ? '文件转存失败，请重新生成'
            : '文件正在转存，完成后可下载'}
          {file.bytes ? ' · ' + Math.ceil(file.bytes / 1024) + ' KB' : ''}
        </span>
      </span>
    </>
  );
  const classes = 'flex max-w-full min-w-0 items-center gap-3 rounded-xl border border-border-medium px-4 py-3';
  // Do not open the 202 JSON placeholder in another tab, and never offer a
  // dead download on a 503 failed archival. Only durable-ready links are live.
  return ready ? (
    <a href={file.url} target="_blank" rel="noopener noreferrer"
      referrerPolicy="no-referrer" className={classes + ' no-underline hover:bg-surface-secondary'}>
      {card}
    </a>
  ) : (
    <div role="status" aria-live="polite" className={classes + ' opacity-75'}>
      {card}
    </div>
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
      {doc.imageMappingEvidence === 'unique-dimensions-unverified' ? (
        <div role="note" className="mb-2 text-xs text-text-secondary">
          图片仅按唯一尺寸候选位置展示，尚未通过内容哈希验证，不能视为 1:1 还原。
        </div>
      ) : null}
      <NativeElement node={doc.root} doc={doc} />
      {doc.files?.length ? (
        <div data-testid="mv3c-native-files" className="mt-3 flex flex-wrap gap-3">
          {doc.files.map(file => (
            <NativeGeneratedFile key={file.url} file={file} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
