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
    <h1
      {...props}
      className="text-l font-heavy mt-(--space-l) mb-(--space-s) first:mt-0"
    />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      {...props}
      className="text-l font-medium mt-(--space-l) mb-(--space-xs) first:mt-0"
    />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      {...props}
      className="text-s font-heavy mt-(--space-m) mb-(--space-xs) first:mt-0"
    />
  ),
  h4: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      {...props}
      className="text-s font-medium mt-(--space-s) mb-(--space-xxs) first:mt-0"
    />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props} className="text-s font-regular mb-(--space-xs) last:mb-0" />
  ),
  strong: (props: React.HTMLAttributes<HTMLElement>) => (
    <strong {...props} className="font-heavy" />
  ),
  em: (props: React.HTMLAttributes<HTMLElement>) => (
    <em {...props} className="italic" />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground hover:underline break-all font-medium"
    />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul
      {...props}
      className="list-disc ml-(--space-l) my-(--space-s) space-y-(--space-xxs)"
    />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol
      {...props}
      className="list-decimal ml-(--space-l) my-(--space-s) space-y-(--space-xxs)"
    />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => (
    <li {...props} className="text-s font-regular" />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      {...props}
      className="border-l-4 border-border pl-(--space-m) my-(--space-s) text-muted-foreground italic"
    />
  ),
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr {...props} className="my-(--space-m) border-border" />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code
      {...props}
      className="px-(--space-xxs) py-0.5 bg-muted rounded-xs text-s font-mono break-all"
    />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      {...props}
      className="surface-inset flex w-full min-w-0 my-(--space-m) overflow-hidden"
    >
      <code className="flex-1 min-w-0 p-(--space-m) text-s font-mono whitespace-pre overflow-x-auto">
        {props.children}
      </code>
    </pre>
  ),
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto my-(--space-s) rounded-(--radius-s) shadow-(--edge)">
      <table {...props} className="min-w-full border-collapse text-s" />
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
      className="even:bg-neutral-3-transparent border-b border-border last:border-0"
    />
  ),
  th: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th
      {...props}
      className="px-(--space-m) py-(--space-xs) text-left text-s font-medium text-muted-foreground border-b border-border"
    />
  ),
  td: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td
      {...props}
      className="px-(--space-m) py-(--space-xs) border-b border-border"
    />
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
