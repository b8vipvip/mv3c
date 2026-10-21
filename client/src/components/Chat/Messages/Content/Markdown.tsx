import React, { memo, useRef, useEffect } from 'react';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from './markdownConfig';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import { FADE_HYDRATION_THRESHOLD } from './animate';
import MarkdownBlocks from './MarkdownBlocks';

type TContentProps = {
  content: string;
  isLatestMessage: boolean;
};

const Markdown = memo(function Markdown({ content = '', isLatestMessage }: TContentProps) {
  const { useMessage, useLaTeXParsing } = useMessagePartsHost();
  const { isSubmitting = false } = useMessage();
  const smoothStreaming = useSmoothStreaming();
  const LaTeXParsing = useLaTeXParsing();
  const isInitializing = content === '';

  const streaming = isLatestMessage && isSubmitting;
  // Legacy providers may stream an incomplete ![...](data:image;base64, ...)
  // one token at a time. Never render its unfinished Base64 as plain text.
  // chat2api now returns short archived media URLs, so this is a fallback.
  const inlineIndex = content.indexOf('](data:image/');
  const imageStart = inlineIndex >= 0 ? content.lastIndexOf('![', inlineIndex) : -1;
  const unfinishedInlineImage = imageStart >= 0 &&
    content.indexOf(')', inlineIndex + 2) < 0;
  const renderContent = unfinishedInlineImage
    ? content.slice(0, imageStart) + '\n\n*图片正在接收…*'
    : content;
  const animate = smoothStreaming && streaming;

  // Hydration signal for the fade: substantial content already present at the
  // render where `animate` flips on means resumed/switched-to/follow-up
  // content, which becomes the fade baseline instead of re-animating. The flag
  // is cleared after that render commits, so blocks mounting later in the same
  // stream (new paragraphs, however large) always animate.
  const prevAnimateRef = useRef(false);
  const hydratedRef = useRef(false);
  if (animate && !prevAnimateRef.current) {
    hydratedRef.current = content.length > FADE_HYDRATION_THRESHOLD;
  }
  prevAnimateRef.current = animate;
  useEffect(() => {
    if (animate) {
      hydratedRef.current = false;
    }
  }, [animate]);

  if (isInitializing) {
    return (
      <div className="absolute">
        <p className="relative">
          <span className={isLatestMessage ? 'result-thinking' : ''} />
        </p>
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary content={renderContent} codeExecution={true}>
      <MarkdownBlocks
        content={renderContent}
        streaming={streaming}
        remarkPlugins={getRemarkPlugins(LaTeXParsing)}
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
        animate={animate}
        hydrated={hydratedRef.current}
      />
    </MarkdownErrorBoundary>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;
