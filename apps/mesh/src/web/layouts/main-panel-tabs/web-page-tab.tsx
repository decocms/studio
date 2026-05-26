/**
 * WebPageTab — side-panel preview of a generated HTML page.
 *
 * The HTML itself is NOT streamed through the chat. The model writes to
 * the sandbox; the wrapped `write`/`edit` tools enqueue the new content
 * into a per-turn buffer (`html-page-buffer`) and return `htmlPreview`
 * synchronously so the chat row paints "Page updated" immediately. The
 * actual S3 PUT happens once per step from `htmlPageBuffer.flush()`,
 * which is hooked into `onStepFinish` via `pendingOps` (awaited at
 * `onFinish` before the stream closes).
 *
 * Iframe gating: this component does NOT load the URL straight from the
 * tool's `htmlPreview` — that would race the deferred PUT. Instead, it
 * waits for a `data-html-page-published` part emitted from the flush
 * after the PUT lands, then iframes the URL from that data event. While
 * waiting, the panel shows a shimmer.
 *
 * Cache-bust: `?v=<bytes>` from the publish event forces the iframe to
 * refetch when the same slug is re-published with a different size, so
 * the browser doesn't serve a cached stale body.
 */

import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check, Copy01, LinkExternal01 } from "@untitledui/icons";
import { useState } from "react";
import { useOptionalChatStream } from "@/web/components/chat/context.tsx";

const FADE_MS = 300;

interface HtmlPagePublished {
  slug: string;
  key: string;
  url: string;
  bytes: number;
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

function PreviewSlot({ url, title }: { url: string; title: string }) {
  const [iframeReady, setIframeReady] = useState(false);
  const [shimmerMounted, setShimmerMounted] = useState(true);

  return (
    <div className="relative h-full w-full bg-background">
      <iframe
        src={url}
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
      {shimmerMounted && (
        <div
          className={cn(
            "absolute inset-0 transition-opacity ease-out",
            iframeReady ? "opacity-0 pointer-events-none" : "opacity-100",
          )}
          style={{ transitionDuration: `${FADE_MS}ms` }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "opacity" && iframeReady) {
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

interface UnknownPart {
  type?: string;
  data?: unknown;
}

/**
 * Scan messages newest-first for the latest `data-html-page-published`
 * part whose `data.slug` matches. Bursts of write/edit calls collapse to
 * one published event per step; iteration ("update the page") naturally
 * surfaces the most recent published event.
 */
function findLatestPublished(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
  slug: string,
): HtmlPagePublished | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const raw = parts[j] as UnknownPart | null;
      if (!raw || raw.type !== "data-html-page-published") continue;
      const data = raw.data as HtmlPagePublished | undefined;
      if (!data) continue;
      if (data.slug === slug) return data;
    }
  }
  return null;
}

function PreviewToolbar({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <button
        type="button"
        onClick={() => window.open(url, "_blank", "noopener")}
        className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={url}
      >
        <span className="truncate">{url}</span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy01 size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {copied ? "Copied" : "Copy URL"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.open(url, "_blank", "noopener")}
          >
            <LinkExternal01 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in new tab</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function WebPageTab({ slug }: { slug: string }) {
  const stream = useOptionalChatStream();
  const messages = stream?.messages ?? [];
  const latest = findLatestPublished(messages, slug);

  if (!latest) {
    return (
      <div className="h-full w-full bg-background">
        <PageShimmer />
      </div>
    );
  }

  const cacheBustedUrl = `${latest.url}${latest.url.includes("?") ? "&" : "?"}v=${latest.bytes}`;
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <PreviewToolbar url={latest.url} />
      <div className="relative flex-1">
        <PreviewSlot url={cacheBustedUrl} title={`${slug}.html`} />
      </div>
    </div>
  );
}
