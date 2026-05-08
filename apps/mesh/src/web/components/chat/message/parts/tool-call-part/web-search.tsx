"use client";

import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { Globe02, LinkExternal01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useOrg } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";
import { MemoizedMarkdown } from "../../../markdown.tsx";
import { formatDuration } from "@/web/lib/format-time.ts";
import {
  type UsageStats,
  type UsageData,
  getCostFromUsage,
} from "@decocms/mesh-sdk";
import { parseMeshStorageKey } from "@/api/routes/decopilot/mesh-storage-uri";

function resolveStorageUri(uri: string, orgSlug: string): string {
  const key = parseMeshStorageKey(uri);
  if (key !== null) return `/api/${orgSlug}/files/${key}`;
  return uri;
}

interface Citation {
  url: string;
  title?: string;
}

interface WebSearchResult {
  success?: boolean;
  content?: string;
  uri?: string;
  query?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    providerMetadata?: Record<string, unknown>;
  };
  citations?: Citation[];
}

function extractUsage(result: WebSearchResult | undefined): UsageStats | null {
  if (!result?.usage) return null;
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  if (!totalTokens) return null;
  const usageData: UsageData = {
    inputTokens,
    outputTokens,
    totalTokens,
    providerMetadata: result.usage.providerMetadata,
  };
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens,
    cost: getCostFromUsage(usageData),
  };
}

interface WebSearchPartProps {
  part: ToolUIPart;
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
  /** Accumulated streaming text from data-web-search parts */
  streamingText?: string;
}

/** Extract a short display hostname from a URL. */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Get a favicon URL for a given site. */
function getFaviconUrl(url: string): string {
  try {
    const origin = new URL(url).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function SourceChip({
  citation,
  index,
}: {
  citation: Citation;
  index: number;
}) {
  const hostname = getHostname(citation.url);
  const faviconUrl = getFaviconUrl(citation.url);
  const label = citation.title || hostname;

  return (
    <a
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group/src inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:border-border hover:text-foreground"
    >
      <img
        src={faviconUrl}
        alt=""
        className="size-3.5 rounded-sm shrink-0"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <span className="truncate max-w-[180px]">{label}</span>
      <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
        [{index + 1}]
      </span>
      <LinkExternal01
        size={10}
        className="shrink-0 opacity-0 group-hover/src:opacity-100 transition-opacity"
      />
    </a>
  );
}

/** Replace `[N]` citation refs in text with markdown links to the source URL. */
function linkifyCitations(text: string, citations: Citation[]): string {
  return text.replace(/\[(\d+)\]/g, (match, numStr) => {
    const index = parseInt(numStr, 10) - 1;
    const citation = citations[index];
    if (!citation) return match;
    return `[\\[${numStr}\\]](${citation.url})`;
  });
}

const MAX_VISIBLE_SOURCES = 5;

function SourcesList({ citations }: { citations: Citation[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasOverflow = citations.length > MAX_VISIBLE_SOURCES;
  const visible = expanded
    ? citations
    : citations.slice(0, MAX_VISIBLE_SOURCES);

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((c, i) => (
        <SourceChip key={c.url} citation={c} index={i} />
      ))}
      {hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:border-border hover:text-foreground"
        >
          {expanded
            ? "show less"
            : `+${citations.length - MAX_VISIBLE_SOURCES} more`}
        </button>
      )}
    </div>
  );
}

export function WebSearchPart({
  part,
  latency,
  streamingText,
}: WebSearchPartProps) {
  const org = useOrg();
  const state = getEffectiveState(part.state);
  const input = part.input as { query?: string } | undefined;
  const result = part.output as WebSearchResult | undefined;

  // Resolve blob-stored content for large results
  const blobUrl = result?.uri
    ? resolveStorageUri(result.uri, org.slug)
    : undefined;

  const { data: blobContent } = useQuery({
    queryKey: KEYS.webSearchBlob(blobUrl ?? ""),
    queryFn: async () => {
      const res = await fetch(blobUrl!);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      return res.text();
    },
    enabled: !!blobUrl,
    staleTime: Infinity,
  });

  const isLoading = state === "loading";
  const isDone = state !== "loading" && state !== "error";
  const citations = result?.citations;
  const usage = extractUsage(result);

  // Display priority: inline content > fetched blob > streaming text
  const rawContent = result?.content ?? blobContent ?? streamingText;
  const displayContent =
    rawContent && citations?.length
      ? linkifyCitations(rawContent, citations)
      : rawContent;

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "error") {
    return (
      <ToolCallShell
        icon={<Globe02 size={14} />}
        title="Web search"
        summary="Failed"
        state="error"
        usage={usage}
        trailing={latencyLabel}
      />
    );
  }

  return (
    <ToolCallShell
      icon={
        <Globe02
          size={14}
          className={cn(isLoading ? "animate-pulse" : "text-blue-500")}
        />
      }
      title={isLoading ? "Researching..." : "Web search"}
      summary={
        isDone
          ? (result?.model ?? input?.query?.slice(0, 60))
          : input?.query
            ? `"${input.query.slice(0, 80)}"`
            : undefined
      }
      state={isLoading ? "loading" : "idle"}
      usage={usage}
      trailing={latencyLabel}
      defaultOpen
    >
      <div className="pl-6 pb-3 flex flex-col gap-1 min-w-0">
        {input?.query && (
          <p className="text-xs text-muted-foreground/70 whitespace-pre-wrap wrap-break-word">
            {input.query}
          </p>
        )}

        {/* Research content */}
        {displayContent ? (
          <div className="max-h-96 overflow-y-auto overflow-x-hidden rounded-lg border border-border/40 bg-muted/20 px-4 py-3 min-w-0">
            <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-[13px] leading-relaxed break-words">
              <MemoizedMarkdown id={part.toolCallId} text={displayContent} />
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3">
            <div className="space-y-2 animate-pulse">
              <div className="h-3 rounded bg-muted-foreground/10 w-3/4" />
              <div className="h-3 rounded bg-muted-foreground/10 w-1/2" />
            </div>
          </div>
        )}

        {/* Sources — rendered after content so they don't shift text when they appear */}
        {citations && citations.length > 0 && (
          <SourcesList citations={citations} />
        )}
      </div>
    </ToolCallShell>
  );
}
