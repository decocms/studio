"use client";

import { Monitor01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useOrg } from "@decocms/mesh-sdk";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";
import { ImageLightbox } from "../../../image-lightbox.tsx";
import { formatDuration } from "@/web/lib/format-time.ts";
import { parseMeshStorageKey } from "@/api/routes/decopilot/mesh-storage-uri";

function resolveImageSrc(uri: string, orgSlug: string): string {
  const key = parseMeshStorageKey(uri);
  if (key !== null) return `/api/${orgSlug}/files/${key}`;
  // data: URIs or any other URL — use as-is
  return uri;
}

interface TakeScreenshotResult {
  success?: boolean;
  image?: { uri?: string; mediaType?: string };
  url?: string;
  error?: string;
}

interface TakeScreenshotInput {
  url?: string;
  fullPage?: boolean;
}

interface TakeScreenshotPartProps {
  part: ToolUIPart;
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
}

export function TakeScreenshotPart({ part, latency }: TakeScreenshotPartProps) {
  const org = useOrg();
  const state = getEffectiveState(part.state);
  const input = part.input as TakeScreenshotInput | undefined;
  const result = part.output as TakeScreenshotResult | undefined;
  const uri = result?.image?.uri;
  const pageUrl = result?.url ?? input?.url;
  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<Monitor01 size={14} />}
        title="Taking screenshot"
        summary={pageUrl}
        state="loading"
      />
    );
  }

  if (state === "error" || result?.success === false || !uri) {
    return (
      <ToolCallShell
        icon={<Monitor01 size={14} />}
        title="Take screenshot"
        summary={result?.error ?? "Failed"}
        state="error"
        trailing={latencyLabel}
      />
    );
  }

  const src = resolveImageSrc(uri, org.slug);

  return (
    <div className="flex flex-col gap-2">
      <ToolCallShell
        icon={<Monitor01 size={14} className="text-blue-500" />}
        title="Screenshot"
        summary={pageUrl}
        state="idle"
        trailing={latencyLabel}
      />
      <div className="flex flex-wrap gap-2">
        <ImageLightbox src={src} alt={pageUrl ?? "Screenshot"}>
          <img
            src={src}
            alt={pageUrl ?? "Screenshot"}
            className="max-w-sm max-h-80 object-contain rounded-lg border border-border hover:border-foreground/20 transition-colors"
          />
        </ImageLightbox>
      </div>
    </div>
  );
}
