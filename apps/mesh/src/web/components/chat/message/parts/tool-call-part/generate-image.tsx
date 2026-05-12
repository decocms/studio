"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Image01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useOrg } from "@decocms/mesh-sdk";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";
import { ImageLightbox } from "../../../image-lightbox.tsx";
import type { UsageStats } from "@/web/lib/usage-utils.ts";
import { formatDuration } from "@/web/lib/format-time.ts";
import { parseMeshStorageKey } from "@/api/routes/decopilot/mesh-storage-uri";

function resolveImageSrc(uri: string, orgSlug: string): string {
  const key = parseMeshStorageKey(uri);
  if (key !== null) return `/api/${orgSlug}/files/${key}`;
  // data: URIs or any other URL — use as-is
  return uri;
}

interface GenerateImageResult {
  success?: boolean;
  images?: Array<{ uri?: string; url?: string; mediaType: string }>;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface GenerateImageInput {
  prompt?: string;
  referenceImages?: Array<{ uri?: string; url?: string }>;
}

interface GenerateImagePartProps {
  part: ToolUIPart;
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
}

function extractUsage(
  result: GenerateImageResult | undefined,
): UsageStats | null {
  if (!result?.usage) return null;
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  if (!totalTokens) return null;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens,
    cost: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function ReferenceImageChip({
  uri,
  orgSlug,
}: {
  uri: string;
  orgSlug: string;
}) {
  const src = resolveImageSrc(uri, orgSlug);
  const label =
    parseMeshStorageKey(uri) !== null
      ? uri.slice(uri.lastIndexOf("/") + 1)
      : "reference";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 px-1 py-0.5 rounded bg-muted text-muted-foreground text-xs cursor-default select-none">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm p-1.5">
        <img
          src={src}
          alt={label}
          className="max-w-full max-h-64 object-contain rounded"
        />
      </TooltipContent>
    </Tooltip>
  );
}

export function GenerateImagePart({ part, latency }: GenerateImagePartProps) {
  const org = useOrg();
  const state = getEffectiveState(part.state);
  const input = part.input as GenerateImageInput | undefined;
  const result = part.output as GenerateImageResult | undefined;
  const images = result?.images;
  const usage = extractUsage(result);
  const modelLabel = result?.model;
  const refImages = Array.isArray(input?.referenceImages)
    ? input.referenceImages.filter((r) => r.uri ?? r.url)
    : undefined;
  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<Image01 size={14} />}
        title="Generating image"
        summary={input?.prompt ? `"${input.prompt.slice(0, 80)}…"` : undefined}
        state="loading"
      />
    );
  }

  if (state === "error" || !images || images.length === 0) {
    return (
      <ToolCallShell
        icon={<Image01 size={14} />}
        title="Image generation"
        summary={state === "error" ? "Failed" : "No images generated"}
        state={state === "error" ? "error" : "idle"}
        usage={usage}
        trailing={latencyLabel}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ToolCallShell
        icon={<Image01 size={14} className="text-pink-500" />}
        title="Generated image"
        summary={modelLabel}
        state="idle"
        usage={usage}
        trailing={latencyLabel}
      >
        <div className="flex flex-col gap-1 pb-2 pl-6">
          {input?.prompt && (
            <p className="text-xs text-muted-foreground/70 whitespace-pre-wrap wrap-break-word">
              {input.prompt}
            </p>
          )}
          {refImages && refImages.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-muted-foreground/50">
                references:
              </span>
              {refImages.map((ref, i) => {
                const raw = (ref.uri ?? ref.url)!;
                return (
                  <ReferenceImageChip key={i} uri={raw} orgSlug={org.slug} />
                );
              })}
            </div>
          )}
        </div>
      </ToolCallShell>
      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => {
          const raw = img.uri ?? img.url;
          if (!raw) return null;
          const src = resolveImageSrc(raw, org.slug);
          return (
            <ImageLightbox
              key={i}
              src={src}
              alt={input?.prompt ?? "Generated image"}
            >
              <img
                src={src}
                alt={input?.prompt ?? "Generated image"}
                className="max-w-sm max-h-80 object-contain rounded-lg border border-border hover:border-foreground/20 transition-colors"
              />
            </ImageLightbox>
          );
        })}
      </div>
    </div>
  );
}
