import React, { memo, useMemo, useRef, useEffect, useState } from 'react';
import { Github, Link2 } from 'lucide-react';
import { sourceFaviconDomain } from './inlineReferenceIcon';
import { PermissionTypes, Permissions, apiBaseUrl } from 'librechat-data-provider';
import {
  handleDoubleClick,
  triggerDownload,
  resolveInlineMedia,
  toAbsoluteFilePath,
} from '~/utils';
import Mermaid, { MermaidErrorBoundary } from '~/components/Messages/Content/Mermaid';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { useCodeBlockContext, useMediaContext } from '~/Providers';
import CodeBlock from '~/components/Messages/Content/CodeBlock';
import { isSafeRasterImageDataUrl } from './inlineImageUrl';
import { generatedFileHref } from './generatedFile';
import ImagePreview from './Image';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { useFileDownload } from '~/data-provider';
import { useLocalize } from '~/hooks';

type TCodeProps = {
  inline?: boolean;
  className?: string;
  children: React.ReactNode;
};

const isSingleLineCode = (children: React.ReactNode): boolean => {
  if (typeof children === 'string') {
    return !children.includes('\n');
  }
  if (Array.isArray(children)) {
    return children.every((child) => typeof child === 'string' && !child.includes('\n'));
  }
  return false;
};

export const code: React.ElementType = memo(function MarkdownCode({
  className,
  children,
}: TCodeProps) {
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];
  const isMath = lang === 'math';
  const isMermaid = lang === 'mermaid';
  const isSingleLine = isSingleLineCode(children);

  const { getNextIndex, getNextMermaidIndex, resetCounter } = useCodeBlockContext();
  const blockIndex = useRef(getNextIndex(isMath || isMermaid || isSingleLine)).current;
  /* Mermaid fences do not consume a code-block index, so every one of them in a
   * message would otherwise share `blockIndex` and collapse onto a single
   * artifact id. They carry their own sequence instead. */
  const mermaidIndex = useRef(isMermaid ? getNextMermaidIndex() : -1).current;

  useEffect(() => {
    resetCounter();
  }, [children, resetCounter]);

  if (isMath) {
    return <>{children}</>;
  } else if (isMermaid) {
    const content = typeof children === 'string' ? children : String(children);
    return (
      <MermaidErrorBoundary code={content}>
        <Mermaid id={`mermaid-${mermaidIndex}`}>{content}</Mermaid>
      </MermaidErrorBoundary>
    );
  } else if (isSingleLine) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return (
      <CodeBlock
        lang={lang ?? 'text'}
        codeChildren={children}
        blockIndex={blockIndex}
        allowExecution={canRunCode}
      />
    );
  }
});
code.displayName = 'MarkdownCode';

export const codeNoExecution: React.ElementType = memo(function MarkdownCodeNoExecution({
  className,
  children,
}: TCodeProps) {
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];

  if (lang === 'math') {
    return children;
  } else if (lang === 'mermaid') {
    const content = typeof children === 'string' ? children : String(children);
    return <Mermaid>{content}</Mermaid>;
  } else if (isSingleLineCode(children)) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return <CodeBlock lang={lang ?? 'text'} codeChildren={children} allowExecution={false} />;
  }
});
codeNoExecution.displayName = 'MarkdownCodeNoExecution';

type TAnchorProps = {
  href: string;
  children: React.ReactNode;
};

export const a: React.ElementType = memo(function MarkdownAnchor({ href, children }: TAnchorProps) {
  const { useUser, useToast } = useMessagePartsHost();
  const user = useUser();
  const showToast = useToast();
  const localize = useLocalize();

  const {
    file_id = '',
    filename = '',
    filepath,
  } = useMemo(() => {
    const pattern = new RegExp(`(?:files|outputs)/${user?.id}/([^\\s]+)`);
    const match = href.match(pattern);
    if (match && match[0]) {
      const path = match[0];
      const parts = path.split('/');
      const name = parts.pop();
      const file_id = parts.pop();
      return { file_id, filename: name, filepath: path };
    }
    return { file_id: '', filename: '', filepath: '' };
  }, [user?.id, href]);

  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file_id, { direct: false });
  const props: { target?: string; onClick?: React.MouseEventHandler } = { target: '_blank' };

  if (!file_id || !filename) {
    const generated = generatedFileHref(
      href,
      typeof window !== 'undefined' && window.location.protocol === 'https:',
    );
    if (generated) {
      return (
        <a
          href={generated}
          target="_blank"
          rel="noopener noreferrer"
          className="border-border-light bg-surface-secondary text-text-primary my-2 inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 no-underline hover:underline"
          title="下载已转存的生成文件"
        >
          <span aria-hidden="true">📎</span>
          <span className="min-w-0 truncate">{children}</span>
          <span className="text-text-secondary text-xs" aria-hidden="true">↓</span>
        </a>
      );
    }
    return (
      <a href={href} {...props} rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  const handleDownload = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    try {
      const stream = await downloadFile();
      if (stream.data == null || stream.data === '') {
        console.error('Error downloading file: No data found');
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
        return;
      }
      triggerDownload(stream.data, filename);
    } catch (error) {
      console.error('Error downloading file:', error);
    }
  };

  props.onClick = handleDownload;
  props.target = '_blank';

  const domainServerBaseUrl = `${apiBaseUrl()}/api`;

  return (
    <a
      href={
        filepath?.startsWith('files/')
          ? `${domainServerBaseUrl}/${filepath}`
          : `${domainServerBaseUrl}/files/${filepath}`
      }
      {...props}
    >
      {children}
    </a>
  );
});
a.displayName = 'MarkdownAnchor';

type TParagraphProps = {
  children: React.ReactNode;
};

export const p: React.ElementType = memo(function MarkdownParagraph({ children }: TParagraphProps) {
  return <p className="mb-2 whitespace-pre-wrap">{children}</p>;
});
p.displayName = 'MarkdownParagraph';

type TTableProps = {
  children: React.ReactNode;
};

export const table: React.ElementType = memo(function MarkdownTable({ children }: TTableProps) {
  return (
    <div className="markdown-table-wrapper w-full max-w-full">
      <table>{children}</table>
    </div>
  );
});
table.displayName = 'MarkdownTable';

type TImageProps = {
  src?: string;
  alt?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
};

export const img: React.ElementType = memo(function MarkdownImage({
  src,
  alt,
  title,
  className,
  style,
}: TImageProps) {
  // Citation favicons are inline 16px source indicators, never generated
  // images requiring a gallery skeleton, remote file ownership or download.
  const faviconDomain = sourceFaviconDomain(src);
  const [faviconFailed, setFaviconFailed] = useState(false);
  // Get the base URL from the API endpoints
  const baseURL = apiBaseUrl();
  /** A model writing `![DTI](5_dti.png)` is naming a file its run produced,
   *  not a path the browser can fetch. Resolving the reference against the
   *  turn's attachments is what turns those into the chart instead of a
   *  broken-image glyph; an unmatched source keeps its original behavior. */
  const { attachmentsByName } = useMediaContext();

  const fixedSrc = useMemo(() => {
    if (!src) return src;
    // Already validated by Markdown URL policy. Never reinterpret an inline
    // raster image as a local file path or prepend the mv3c API base URL.
    if (isSafeRasterImageDataUrl(src)) return src;
    const resolved = resolveInlineMedia(src, attachmentsByName)?.filepath ?? src;
    return toAbsoluteFilePath(resolved, baseURL);
  }, [src, baseURL, attachmentsByName]);

  // Markdown output images share the same bounded preview/lightbox as
  // uploaded/generated attachments. Raw <img> rendered full-resolution at
  // document width and offered no click-through original.
  if (faviconDomain) {
    const name = alt && alt !== '图片' ? alt : faviconDomain;
    if (faviconDomain === 'github.com' || faviconDomain.endsWith('.github.com')) {
      return <Github aria-label={name} className="mx-0.5 inline-block size-4 align-[-2px]" />;
    }
    if (faviconFailed) {
      return <Link2 aria-label={name} className="mx-0.5 inline-block size-4 align-[-2px]" />;
    }
    return (
      <img
        src={src}
        alt={name}
        title={title || faviconDomain}
        className="mx-0.5 inline-block size-4 align-[-2px] object-contain"
        loading="lazy"
        onError={() => setFaviconFailed(true)}
      />
    );
  }
  if (!fixedSrc) return null;
  return <ImagePreview imagePath={fixedSrc} altText={alt || title || '生成图片'} className={className} />;
});
img.displayName = 'MarkdownImage';
