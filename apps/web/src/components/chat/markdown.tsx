/* eslint-disable ban-memoization/ban-memoization */
import { marked } from "marked";
import React, {
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { markdownComponents as sharedMarkdownComponents } from "@deco/ui/components/markdown.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { ImageLightbox } from "./image-lightbox.tsx";
import { resolveOrgFileBrowsePath } from "./org-file-ref.ts";
import { OrgFileOpenContext } from "./org-file-open-context.tsx";
import { useT } from "@/i18n/use-t.ts";
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
  const t = useT();
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
          aria-label={t("chat.markdown.copyAsCSV")}
          className="text-muted-foreground hover:text-foreground h-6 text-[10px]"
          type="button"
        >
          {t("chat.markdown.copyAsCSV")}
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

function MarkdownImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const t = useT();
  const { src, alt, ...rest } = props;
  if (!src) return <img {...props} />;
  return (
    <ImageLightbox src={src} alt={alt ?? t("chat.markdown.image")}>
      <img
        {...rest}
        src={src}
        alt={alt}
        className="max-w-full rounded-lg border border-border hover:border-foreground/20 transition-colors"
      />
    </ImageLightbox>
  );
}

// Memoize the plugins array to prevent re-creating it on every render.
// No rehype-raw here: assistant text can carry web-search / tool-output
// content, and rehype-raw renders embedded raw HTML with no sanitization —
// a real XSS vector (see the same concern noted in checks-tab.tsx).
const remarkPluginsMemo = [remarkGfm];

// Extend shared markdown components with chat-specific overrides (table with CSV
// copy, image lightbox, clickable org-file references).
const markdownComponents = {
  ...sharedMarkdownComponents,
  code: (props: MdProps) => <MarkdownCode {...props} />,
  a: (props: MdProps) => <MarkdownAnchor {...props} />,
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <Table {...props} />
  ),
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <MarkdownImage {...props} />
  ),
} as typeof sharedMarkdownComponents;

// ── Streaming word fade-in ───────────────────────────────────────────────────
// Splits a text run into per-word spans that fade in once on mount. Keys are
// the word INDEX: streaming only ever appends, so settled words keep their key
// (React updates them in place → the CSS fade never re-runs) and only new
// trailing words mount and animate. `memo` keeps unchanged runs from
// re-rendering. This index-keyed leaf is the whole trick — it's what an earlier
// rehype-plugin attempt lacked, which made entire blocks re-fade.
const WORD_SPLIT = /(\s+)/;
const AnimatedText = memo(function AnimatedText({ text }: { text: string }) {
  const tokens = useMemo(
    () => text.split(WORD_SPLIT).filter((t) => t.length > 0),
    [text],
  );
  return (
    <>
      {tokens.map((tok, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable for append-only streaming
        <span key={i} className="stream-word">
          {tok}
        </span>
      ))}
    </>
  );
});
AnimatedText.displayName = "AnimatedText";

// Wrap string children in the per-word animator; pass elements through so they
// animate via their own (animated) component override.
const animateText = (children: React.ReactNode): React.ReactNode =>
  React.Children.map(children, (child) =>
    typeof child === "string" ? <AnimatedText text={child} /> : child,
  );

type MdProps = {
  node?: unknown;
  children?: React.ReactNode;
} & Record<string, unknown>;

// Inline-code styling, mirrored from the shared design-system `code` override.
const INLINE_CODE_CLASS =
  "px-1 py-0.5 bg-background border border-border rounded text-[14px] font-mono break-all";

// Inline code that names an org file becomes a clickable chip; everything else
// keeps the plain code styling. Block code (rendered via `pre > code`, and the
// fenced blocks MemoizedMarkdown pre-splits) is never linkified. The chip is
// clickable ONLY under an OrgFileOpenProvider (the chat shell) — elsewhere the
// nav can't resolve, so it stays plain rather than a dead click.
function MarkdownCode({ node: _n, className, children, ...p }: MdProps) {
  const t = useT();
  const ctx = useContext(OrgFileOpenContext);
  const isBlock =
    typeof className === "string" && className.includes("language-");
  const text = typeof children === "string" ? children : null;
  const browsePath =
    ctx && !isBlock && text
      ? resolveOrgFileBrowsePath(text, ctx.orgSlug, ctx.threadId)
      : null;
  if (!ctx || !browsePath) {
    return (
      <code className={INLINE_CODE_CLASS} {...p}>
        {children}
      </code>
    );
  }
  return (
    <button
      type="button"
      onClick={() => ctx.open(browsePath)}
      className={cn(
        INLINE_CODE_CLASS,
        "text-primary-dark hover:underline cursor-pointer",
      )}
      title={t("chat.markdown.openFile")}
    >
      {children}
    </button>
  );
}

// Markdown links whose href is an org file path open the in-chat preview;
// all other links keep their external-tab behavior. `animate` routes the label
// through the streaming word-fade animator. Like MarkdownCode, the in-chat
// preview is wired only under an OrgFileOpenProvider.
function MarkdownAnchor({
  node: _n,
  children,
  animate,
  ...p
}: MdProps & { animate?: boolean }) {
  const ctx = useContext(OrgFileOpenContext);
  const href = typeof p.href === "string" ? p.href : undefined;
  const browsePath =
    ctx && href
      ? resolveOrgFileBrowsePath(href, ctx.orgSlug, ctx.threadId)
      : null;
  const label = animate ? animateText(children) : children;
  if (ctx && browsePath) {
    return (
      <button
        type="button"
        onClick={() => ctx.open(browsePath)}
        className="text-primary-dark hover:underline break-all font-medium cursor-pointer"
      >
        {label}
      </button>
    );
  }
  return (
    <a
      {...p}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-dark hover:underline break-all font-medium"
    >
      {label}
    </a>
  );
}

// Same design-system styling as `markdownComponents`, but text-bearing elements
// route their text through `animateText`. Used only while a message streams.
const animatedComponents = {
  ...markdownComponents,
  h1: ({ node: _n, children, ...p }: MdProps) => (
    <h1 {...p} className="text-2xl font-bold mt-6 mb-3 first:mt-0">
      {animateText(children)}
    </h1>
  ),
  h2: ({ node: _n, children, ...p }: MdProps) => (
    <h2 {...p} className="text-xl font-semibold mt-5 mb-2 first:mt-0">
      {animateText(children)}
    </h2>
  ),
  h3: ({ node: _n, children, ...p }: MdProps) => (
    <h3 {...p} className="text-lg font-semibold mt-4 mb-2 first:mt-0">
      {animateText(children)}
    </h3>
  ),
  h4: ({ node: _n, children, ...p }: MdProps) => (
    <h4 {...p} className="text-base font-semibold mt-3 mb-1 first:mt-0">
      {animateText(children)}
    </h4>
  ),
  p: ({ node: _n, children, ...p }: MdProps) => (
    <p {...p} className="leading-relaxed text-[14px] mb-2 last:mb-0">
      {animateText(children)}
    </p>
  ),
  strong: ({ node: _n, children, ...p }: MdProps) => (
    <strong {...p} className="font-bold">
      {animateText(children)}
    </strong>
  ),
  em: ({ node: _n, children, ...p }: MdProps) => (
    <em {...p} className="italic">
      {animateText(children)}
    </em>
  ),
  li: ({ node: _n, children, ...p }: MdProps) => (
    <li {...p} className="leading-relaxed text-[14px]">
      {animateText(children)}
    </li>
  ),
  a: (props: MdProps) => <MarkdownAnchor {...props} animate />,
} as typeof markdownComponents;

const MemoizedMarkdownBlock = memo(
  ({ content, animate }: { content: string; animate?: boolean }) => {
    return (
      <ReactMarkdown
        remarkPlugins={remarkPluginsMemo}
        components={animate ? animatedComponents : markdownComponents}
      >
        {content}
      </ReactMarkdown>
    );
  },
  (prevProps, nextProps) =>
    prevProps.content === nextProps.content &&
    prevProps.animate === nextProps.animate,
);

function CodeBlock({
  language,
  content,
}: {
  language: string;
  content: string;
}) {
  const t = useT();
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
          aria-label={t("chat.markdown.copyCode")}
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
  /** Fade newly streamed words in — set only for the in-progress message. */
  animate?: boolean;
}

export const MemoizedMarkdown = ({
  id,
  text,
  animate,
}: MemoizedMarkdownProps) => {
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
      <MemoizedMarkdownBlock
        content={block.raw}
        animate={animate}
        key={`${id}-block_${index}`}
      />
    );
  });
};

MemoizedMarkdown.displayName = "MemoizedMarkdown";
