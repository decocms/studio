"use client";

import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Globe02, LinkExternal01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useRef, useState } from "react";
import { formatDuration } from "@/web/lib/format-time.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface WriteHtmlPageInput {
  slug?: string;
  html?: string;
}

interface WriteHtmlPageResult {
  success?: boolean;
  error?: string;
  slug?: string;
  key?: string;
  url?: string;
  bytes?: number;
}

interface WriteHtmlPagePartProps {
  part: ToolUIPart;
  latency?: number;
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes == null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FRAME_CLASS =
  "overflow-hidden rounded-lg border border-border bg-background";
const FRAME_HEIGHT = "480px";
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
 *      browser to re-wrap the entire string on each paint. With `pre`
 *      the browser just lays out monospace text once.
 *
 * Auto-scroll piggybacks on the same rAF: after writing text we set
 * `scrollTop = scrollHeight`. The user can scroll up manually; the
 * next chunk will snap them back. (Acceptable for a streaming view.)
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
      // Mount with the current buffer — without this, the pre would
      // show empty for one frame on the initial paint.
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
        className="m-0 whitespace-pre p-3 font-mono text-xs leading-relaxed text-muted-foreground"
      />
    </div>
  );
}

/**
 * Landing-page-shaped skeleton shown while we're streaming but no HTML
 * has arrived yet. Bytes come from the model with `slug` sometimes
 * landing seconds before `html`, so the iframe slot would otherwise be
 * a blank white box for the gap.
 *
 * Uses the `Skeleton` component (animate-pulse) rather than the repo's
 * `.shimmer` class — the latter is text-clip based and invisible on
 * empty divs.
 */
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
 * Container that smoothly crosses shimmer → code view → iframe.
 *
 * Three z-stacked layers, each absolutely positioned in the same
 * 480px slot:
 *
 *   1. Iframe (bottom) — mounts when streaming ends with content;
 *      fades in on its own `onLoad`.
 *   2. Code view (middle) — mounts once any HTML arrives; pops in
 *      under the shimmer, stays visible until iframe is ready, then
 *      fades out and unmounts on `transitionend`.
 *   3. Shimmer (top) — mounted initially while streaming and the
 *      buffer is still empty; fades out the moment the first chunk
 *      arrives (revealing the code view underneath), then unmounts.
 *
 * Each layer's mount lifecycle is gated by a state flag flipped from
 * its own `transitionend` handler, so we never keep extra DOM alive
 * past the swap, and the crossfades are never interrupted mid-fade.
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
    <div
      className={cn(FRAME_CLASS, "relative")}
      style={{ height: FRAME_HEIGHT }}
    >
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
            // Unmount the code view only after its fade-out completes,
            // so the crossfade is uninterrupted. Guard on opacity +
            // state so we don't unmount during the initial fade-in.
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

export function WriteHtmlPagePart({ part, latency }: WriteHtmlPagePartProps) {
  const state = getEffectiveState(part.state);
  const input = part.input as WriteHtmlPageInput | undefined;
  const result = part.output as WriteHtmlPageResult | undefined;
  const partialHtml = input?.html ?? "";
  const hasPartial = partialHtml.trim().length > 0;
  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading") {
    const slug = input?.slug ?? "index";
    const sizeLabel = hasPartial
      ? formatBytes(new TextEncoder().encode(partialHtml).length)
      : undefined;
    return (
      <div className="flex flex-col gap-2">
        <ToolCallShell
          icon={<Globe02 size={14} />}
          title="Writing page"
          summary={sizeLabel ? `${slug}.html · ${sizeLabel}` : `${slug}.html`}
          state="loading"
        />
        <PreviewSlot
          html={partialHtml}
          isStreaming
          title={`${slug}.html (writing)`}
        />
      </div>
    );
  }

  if (state === "error" || !result?.success) {
    return (
      <ToolCallShell
        icon={<Globe02 size={14} />}
        title="Write page"
        summary={result?.error ?? "Failed"}
        state="error"
        trailing={latencyLabel}
      />
    );
  }

  const slug = result.slug ?? input?.slug ?? "index";
  const sizeLabel = formatBytes(result.bytes);
  // After the tool resolves, the AI SDK keeps the validated input on
  // the part — use that as the source of truth instead of refetching
  // the stored file. Same bytes the agent just wrote, zero network.
  const finalHtml = input?.html ?? "";

  return (
    <div className="flex flex-col gap-2">
      <ToolCallShell
        icon={<Globe02 size={14} className="text-sky-500" />}
        title="Page updated"
        summary={sizeLabel ? `${slug}.html · ${sizeLabel}` : `${slug}.html`}
        state="idle"
        trailing={
          result.url ? (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <LinkExternal01 size={12} />
              Open
            </a>
          ) : (
            latencyLabel
          )
        }
      />
      {finalHtml && (
        <PreviewSlot
          html={finalHtml}
          isStreaming={false}
          title={`${slug}.html`}
        />
      )}
    </div>
  );
}
