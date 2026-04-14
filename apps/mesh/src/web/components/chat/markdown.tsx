/* eslint-disable ban-memoization/ban-memoization */
import { marked } from "marked";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { Button } from "@deco/ui/components/button.tsx";
import { markdownComponents as sharedMarkdownComponents } from "@deco/ui/components/markdown.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { ImageLightbox } from "./image-lightbox.tsx";
// @ts-ignore - correct
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism/index.js";

interface LazyHighlighterProps {
  language: string;
  content: string;
  fillHeight?: boolean;
}

function LazyHighlighter({
  language,
  content,
  fillHeight = false,
}: LazyHighlighterProps) {
  return (
    <SyntaxHighlighter
      language={language || "text"}
      style={oneDark}
      customStyle={{
        margin: 0,
        padding: "1rem",
        fontSize: "0.8rem",
        borderRadius: "0.5rem",
        background: "#282c34",
        position: "relative",
        overflowX: "hidden",
        overflowY: "visible",
        width: "100%",
        maxWidth: "100%",
        display: "block",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        height: fillHeight ? "100%" : undefined,
        minHeight: fillHeight ? "100%" : undefined,
      }}
      codeTagProps={{
        className: "font-mono",
        style: {
          wordBreak: "break-word",
          overflowWrap: "break-word",
          whiteSpace: "pre-wrap",
        },
      }}
      wrapLongLines
    >
      {content}
    </SyntaxHighlighter>
  );
}

// Custom hook for copy functionality - simplified version
function useCopy() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return { handleCopy, copied };
}

function Table(props: React.HTMLAttributes<HTMLTableElement>) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { handleCopy, copied } = useCopy();

  const tableToCsv = useCallback((table: HTMLTableElement | null): string => {
    if (!table) return "";
    const rows = Array.from(table.querySelectorAll("tr"));
    return rows
      .map((row) =>
        Array.from(row.querySelectorAll("th,td"))
          .map((cell) => {
            let text = cell.textContent || "";
            text = text.replace(/"/g, '""');
            if (text.search(/([",\n])/g) >= 0) {
              text = `"${text}"`;
            }
            return text;
          })
          .join(","),
      )
      .join("\n");
  }, []);

  const handleCopyCsv = useCallback(async () => {
    const csv = tableToCsv(tableRef.current);
    await handleCopy(csv);
  }, [tableToCsv, handleCopy]);

  return (
    <>
      <div className="flex justify-end items-center">
        <Button
          variant="ghost"
          onClick={handleCopyCsv}
          aria-label="Copy as CSV"
          className="text-muted-foreground hover:text-foreground h-6 text-[10px]"
          type="button"
        >
          Copy as CSV
          {copied ? <Check size={12} /> : <Copy01 size={12} />}
        </Button>
      </div>
      <div className="overflow-x-auto mb-4 rounded-lg border border-border">
        <table
          ref={tableRef}
          {...props}
          className="min-w-full border-collapse text-sm"
        >
          {props.children}
        </table>
      </div>
    </>
  );
}

// Memoize the plugins arrays to prevent re-creating them on every render
const remarkPluginsMemo = [remarkGfm];
const rehypePluginsMemo = [rehypeRaw];

// Extend shared markdown components with chat-specific overrides (table with CSV copy, image lightbox)
const markdownComponents = {
  ...sharedMarkdownComponents,
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <Table {...props} />
  ),
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const { src, alt, ...rest } = props;
    if (!src) return <img {...props} />;
    return (
      <ImageLightbox src={src} alt={alt ?? "Image"}>
        <img
          {...rest}
          src={src}
          alt={alt}
          className="max-w-full rounded-lg border border-border hover:border-foreground/20 transition-colors"
        />
      </ImageLightbox>
    );
  },
} as typeof sharedMarkdownComponents;

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    return (
      <ReactMarkdown
        remarkPlugins={remarkPluginsMemo}
        rehypePlugins={rehypePluginsMemo}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    );
  },
  (prevProps, nextProps) => prevProps.content === nextProps.content,
);

function CodeBlock({
  language,
  content,
}: {
  language: string;
  content: string;
}) {
  const { handleCopy, copied } = useCopy();

  return (
    <div className="my-4 rounded-lg bg-muted overflow-hidden border border-border grid min-w-0">
      <div className="flex items-center justify-between p-1 pl-4 bg-muted border-b border-border">
        <span className="text-xs font-mono uppercase text-muted-foreground tracking-widest select-none">
          {language ? language : "text"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => handleCopy(content)}
          aria-label="Copy code"
          className="text-muted-foreground hover:text-foreground rounded-lg h-8 w-8"
        >
          {copied ? <Check size={14} /> : <Copy01 size={14} />}
        </Button>
      </div>

      <LazyHighlighter language={language} content={content} />
    </div>
  );
}

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

interface MemoizedMarkdownProps {
  id: string;
  text: string;
}

export const MemoizedMarkdown = ({ id, text }: MemoizedMarkdownProps) => {
  const blocks = useMemo(() => marked.lexer(text), [text]);

  return blocks.map((block, index) => {
    if (block.type === "code") {
      return (
        <CodeBlock
          language={block.lang}
          content={block.text}
          key={`${id}-block_${index}`}
        />
      );
    }

    return (
      <MemoizedMarkdownBlock content={block.raw} key={`${id}-block_${index}`} />
    );
  });
};

MemoizedMarkdown.displayName = "MemoizedMarkdown";
