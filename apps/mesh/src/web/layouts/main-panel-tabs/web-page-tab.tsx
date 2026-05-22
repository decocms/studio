/**
 * WebPageTab — live preview of the web-developer agent's
 * `write_html_page` tool call, rendered in the side panel.
 *
 * Streams off the same `useChatStream()` messages the chat reads, so the
 * iframe paints in lockstep with the model writing HTML. The chat row
 * itself only shows a compact "Page updated" header; the iframe lives
 * here.
 *
 * Lookup: latest `tool-write_html_page` part across all messages whose
 * `input.slug ?? "index"` matches the tab's slug. Iterates messages
 * newest-first so iteration ("update the page") always picks the most
 * recent write.
 */

import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useRef, useState } from "react";
import { useOptionalChatStream } from "@/web/components/chat/context.tsx";
import type { ToolUIPart } from "ai";

interface WriteHtmlPageInput {
  slug?: string;
  html?: string;
}

interface WriteHtmlPageResult {
  success?: boolean;
  error?: string;
  slug?: string;
  url?: string;
  bytes?: number;
}

const FADE_MS = 300;

/**
 * Plain-text streaming view of the HTML buffer.
 *
 * The model emits HTML in bursts — sometimes many large chunks within
 * a single frame. Two things make that affordable here:
 *
 *   1. The text content is updated imperatively on `<pre>.textContent`
 *      inside a single `requestAnimationFrame`. React never reconciles
 *      the text node, so bursts coalesce to one DOM write per frame
 *      regardless of how many parent re-renders fired.
 *   2. `white-space: pre` + horizontal scrolling, NOT `pre-wrap`.
 *      Word-wrap on a 50KB buffer that grows every chunk forces the
 *      browser to re-wrap the entire string on each paint.
 */
function StreamingCodeView({ html, title }: { html: string; title: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const pendingRef = useRef<string>(html);
  const appliedRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  pendingRef.current = html;

  if (
    preRef.current &&
    appliedRef.current !== html &&
    rafRef.current === null &&
    typeof requestAnimationFrame !== "undefined"
  ) {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const next = pendingRef.current;
      const pre = preRef.current;
      const container = containerRef.current;
      if (!pre || appliedRef.current === next) return;
      pre.textContent = next;
      appliedRef.current = next;
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  const attachPre = (el: HTMLPreElement | null) => {
    preRef.current = el;
    if (el && appliedRef.current !== pendingRef.current) {
      el.textContent = pendingRef.current;
      appliedRef.current = pendingRef.current;
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }
  };

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto bg-background"
      aria-label={title}
    >
      <pre
        ref={attachPre}
        className="m-0 whitespace-pre p-4 font-mono text-xs leading-relaxed text-muted-foreground"
      />
    </div>
  );
}

function PageShimmer() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white">
      <div className="flex w-3/4 max-w-md flex-col gap-3 p-6">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="mt-2 h-8 w-24" />
      </div>
    </div>
  );
}

/**
 * Three z-stacked layers fill the panel: iframe (bottom, mounts when
 * streaming ends with content), code view (middle, while streaming or
 * waiting for iframe load), and shimmer (top, while we have neither).
 * Each fades out and unmounts on its own `transitionend` so the
 * crossfades are never interrupted mid-fade.
 */
function PreviewSlot({
  html,
  isStreaming,
  title,
}: {
  html: string;
  isStreaming: boolean;
  title: string;
}) {
  const [iframeReady, setIframeReady] = useState(false);
  const [codeMounted, setCodeMounted] = useState(true);
  const [shimmerMounted, setShimmerMounted] = useState(true);

  const hasContent = html.length > 0;
  const showIframe = !isStreaming && hasContent;
  const codeVisible = hasContent && (isStreaming || !iframeReady);
  const shimmerVisible = isStreaming && !hasContent;

  return (
    <div className="relative h-full w-full bg-background">
      {showIframe && (
        <iframe
          srcDoc={html}
          onLoad={() => setIframeReady(true)}
          sandbox="allow-scripts"
          className={cn(
            "absolute inset-0 block w-full h-full bg-white",
            "transition-opacity ease-out",
            iframeReady ? "opacity-100" : "opacity-0",
          )}
          style={{ transitionDuration: `${FADE_MS}ms` }}
          title={title}
        />
      )}
      {codeMounted && hasContent && (
        <div
          className={cn(
            "absolute inset-0 transition-opacity ease-out",
            codeVisible ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
          style={{ transitionDuration: `${FADE_MS}ms` }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "opacity" && !codeVisible && !isStreaming) {
              setCodeMounted(false);
            }
          }}
        >
          <StreamingCodeView html={html} title={title} />
        </div>
      )}
      {shimmerMounted && (
        <div
          className={cn(
            "absolute inset-0 transition-opacity ease-out",
            shimmerVisible ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
          style={{ transitionDuration: `${FADE_MS}ms` }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "opacity" && !shimmerVisible) {
              setShimmerMounted(false);
            }
          }}
        >
          <PageShimmer />
        </div>
      )}
    </div>
  );
}

interface LatestPart {
  part: ToolUIPart;
  input: WriteHtmlPageInput;
  result: WriteHtmlPageResult | undefined;
}

function findLatestPart(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
  slug: string,
): LatestPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as ToolUIPart;
      if (!part || part.type !== "tool-write_html_page") continue;
      const input = (part.input ?? {}) as WriteHtmlPageInput;
      const result = part.output as WriteHtmlPageResult | undefined;
      const partSlug = input.slug ?? result?.slug ?? "index";
      if (partSlug === slug) {
        return { part, input, result };
      }
    }
  }
  return null;
}

export function WebPageTab({ slug }: { slug: string }) {
  const stream = useOptionalChatStream();
  const messages = stream?.messages ?? [];
  const latest = findLatestPart(messages, slug);

  if (!latest) {
    return (
      <div className="h-full w-full bg-background">
        <PageShimmer />
      </div>
    );
  }

  const { part, input, result } = latest;
  const html = input.html ?? "";
  const isStreaming =
    part.state === "input-streaming" || part.state === "input-available";

  if (part.state === "output-error" || (result && !result.success)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
        {result?.error ?? "Failed to write page."}
      </div>
    );
  }

  return (
    <PreviewSlot html={html} isStreaming={isStreaming} title={`${slug}.html`} />
  );
}
