/**
 * Shared Markdown rendering component.
 *
 * Provides consistently-styled markdown rendering across the app.
 * Consumers that need extra features (syntax highlighting, CSV export, etc.)
 * can extend `markdownComponents` with their own overrides.
 */

import type React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Shared component overrides for ReactMarkdown
// ---------------------------------------------------------------------------

export const markdownComponents: Components = {
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 {...props} className="text-2xl font-bold mt-6 mb-3 first:mt-0" />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props} className="text-xl font-semibold mt-5 mb-2 first:mt-0" />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 {...props} className="text-lg font-semibold mt-4 mb-2 first:mt-0" />
  ),
  h4: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 {...props} className="text-base font-semibold mt-3 mb-1 first:mt-0" />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props} className="leading-relaxed text-[14px] mb-2 last:mb-0" />
  ),
  strong: (props: React.HTMLAttributes<HTMLElement>) => (
    <strong {...props} className="font-bold" />
  ),
  em: (props: React.HTMLAttributes<HTMLElement>) => (
    <em {...props} className="italic" />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-dark hover:underline break-all font-medium"
    />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul {...props} className="list-disc ml-6 my-3 space-y-1.5" />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol {...props} className="list-decimal ml-6 my-3 space-y-1.5" />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => (
    <li {...props} className="leading-relaxed text-[14px]" />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      {...props}
      className="border-l-4 border-border pl-4 my-3 text-muted-foreground italic"
    />
  ),
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr {...props} className="my-4 border-border" />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code
      {...props}
      className="px-1 py-0.5 bg-background border border-border rounded text-[14px] font-mono break-all"
    />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      {...props}
      className="flex w-full min-w-0 my-4 bg-background rounded-lg border border-border overflow-hidden"
    >
      <code className="flex-1 min-w-0 p-4 text-[14px] font-mono whitespace-pre overflow-x-auto">
        {props.children}
      </code>
    </pre>
  ),
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto my-3 rounded-lg border border-border">
      <table {...props} className="min-w-full border-collapse text-sm" />
    </div>
  ),
  thead: (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead {...props} className="bg-muted">
      {props.children}
    </thead>
  ),
  tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr
      {...props}
      className="even:bg-muted/50 border-b border-border last:border-0"
    />
  ),
  th: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th
      {...props}
      className="px-4 py-2 text-left font-semibold text-muted-foreground border-b border-border"
    />
  ),
  td: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td {...props} className="px-4 py-2 border-b border-border" />
  ),
};

// ---------------------------------------------------------------------------
// Plugins (stable references)
// ---------------------------------------------------------------------------

const defaultRemarkPlugins = [remarkGfm];

// ---------------------------------------------------------------------------
// Markdown component
// ---------------------------------------------------------------------------

export interface MarkdownProps {
  children: string;
  /** Extra remark plugins (remarkGfm is always included). */
  remarkPlugins?: React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"];
  /** Extra rehype plugins. */
  rehypePlugins?: React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
  /** Override or extend the default component map. */
  components?: Components;
  /** Additional className on the wrapper div. */
  className?: string;
}

export function Markdown({
  children,
  remarkPlugins,
  rehypePlugins,
  components,
  className,
}: MarkdownProps) {
  const mergedPlugins = remarkPlugins
    ? [...defaultRemarkPlugins, ...remarkPlugins]
    : defaultRemarkPlugins;

  const mergedComponents = components
    ? { ...markdownComponents, ...components }
    : markdownComponents;

  return (
    <div className={className ?? "max-w-none"}>
      <ReactMarkdown
        remarkPlugins={mergedPlugins}
        rehypePlugins={rehypePlugins}
        components={mergedComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
