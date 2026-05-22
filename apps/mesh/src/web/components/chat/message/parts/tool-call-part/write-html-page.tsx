"use client";

import { Globe02, LinkExternal01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useEffect, useRef } from "react";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { formatWebPageTabId } from "@/web/layouts/main-panel-tabs/tab-id";
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

/**
 * Auto-open the side panel the first time a page slug starts streaming,
 * so the user sees the iframe paint in lockstep with the model. Guarded
 * by a ref so we open exactly once per slug — if the user closes the
 * panel manually mid-stream, we stay closed.
 */
function useAutoOpenWebPagePanel(slug: string, shouldOpen: boolean) {
  const { openTab } = usePanelActions();
  const openedSlugRef = useRef<string | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot side effect keyed on first streaming-start per slug
  useEffect(() => {
    if (!shouldOpen) return;
    if (openedSlugRef.current === slug) return;
    openedSlugRef.current = slug;
    openTab(formatWebPageTabId(slug));
  }, [slug, shouldOpen, openTab]);
}

export function WriteHtmlPagePart({ part, latency }: WriteHtmlPagePartProps) {
  const state = getEffectiveState(part.state);
  const input = part.input as WriteHtmlPageInput | undefined;
  const result = part.output as WriteHtmlPageResult | undefined;
  const slug = result?.slug ?? input?.slug ?? "index";
  const { openTab } = usePanelActions();

  useAutoOpenWebPagePanel(slug, state === "loading");

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading") {
    const partialHtml = input?.html ?? "";
    const hasPartial = partialHtml.trim().length > 0;
    const sizeLabel = hasPartial
      ? formatBytes(new TextEncoder().encode(partialHtml).length)
      : undefined;
    return (
      <ToolCallShell
        icon={<Globe02 size={14} />}
        title="Writing page"
        summary={sizeLabel ? `${slug}.html · ${sizeLabel}` : `${slug}.html`}
        state="loading"
      />
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

  const sizeLabel = formatBytes(result.bytes);
  const openInPanel = () => openTab(formatWebPageTabId(slug));

  return (
    <ToolCallShell
      icon={<Globe02 size={14} className="text-sky-500" />}
      title="Page updated"
      summary={sizeLabel ? `${slug}.html · ${sizeLabel}` : `${slug}.html`}
      state="idle"
      trailing={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openInPanel();
            }}
            className="text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            Open preview
          </button>
          {result.url ? (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center text-muted-foreground/70 hover:text-foreground transition-colors"
              onClick={(e) => e.stopPropagation()}
              aria-label="Open in new tab"
            >
              <LinkExternal01 size={12} />
            </a>
          ) : null}
          {latencyLabel}
        </div>
      }
    />
  );
}
