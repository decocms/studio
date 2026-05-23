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

const HTML_PAGE_PATTERN = /^pages\/([a-z0-9][a-z0-9._-]*)\.html$/i;

interface GenericWriteInput {
  path?: string;
  content?: string;
}

interface GenericWriteOutput {
  htmlPreview?: {
    slug: string;
    key: string;
    url: string;
    bytes: number;
  };
  htmlPreviewError?: string;
}

interface ShimmedWriteResult {
  success: boolean;
  error?: string;
  slug?: string;
  key?: string;
  url?: string;
  bytes?: number;
}

/**
 * Normalize parts that affect previewable HTML pages into a shape the
 * WriteHtmlPagePart renderer (and WebPageTab lookup) can consume uniformly.
 * Three input shapes are recognised:
 *
 *  1. The dedicated `tool-write_html_page` part — returned as-is.
 *  2. A generic `tool-write` part whose `input.path` matches
 *     `pages/<slug>.html` — slug derived from the path; success carries
 *     the wrapped `htmlPreview` shape via the mirror layer.
 *  3. A generic `tool-edit` part to the same prefix — same treatment.
 *
 * Returns null when the part is unrelated, when an op to a matching path
 * errored (generic write/edit error row takes over), or when a successful
 * op produced no S3 mirror (claiming "Page updated" without preview
 * details would be misleading).
 */
export function toHtmlPagePart(part: ToolUIPart): ToolUIPart | null {
  if (part.type === "tool-write_html_page") return part;
  if (part.type !== "tool-write" && part.type !== "tool-edit") return null;

  const input = (part.input ?? {}) as GenericWriteInput;
  const rawPath = input.path;
  if (typeof rawPath !== "string") return null;
  const normalized = rawPath.replace(/^\.?\//, "");
  const match = HTML_PAGE_PATTERN.exec(normalized);
  if (!match) return null;
  const slug = match[1]!;

  const output = part.output as GenericWriteOutput | undefined;
  const state = part.state;

  if (state === "output-error") return null;

  let shimmedOutput: ShimmedWriteResult | undefined;
  if (output?.htmlPreview) {
    shimmedOutput = { success: true, ...output.htmlPreview };
  } else if (output?.htmlPreviewError) {
    shimmedOutput = { success: false, slug, error: output.htmlPreviewError };
  } else if (state === "output-available") {
    return null;
  }

  return {
    ...part,
    input: { slug },
    output: shimmedOutput,
  } as ToolUIPart;
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
    return (
      <ToolCallShell
        icon={<Globe02 size={14} />}
        title="Writing page"
        summary={`${slug}.html`}
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
