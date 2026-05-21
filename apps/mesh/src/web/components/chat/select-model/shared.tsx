import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlignLeft,
  ChevronDown,
  Image01,
  ImagePlus,
  SearchMd,
  Stars01,
  Tool01,
} from "@untitledui/icons";
import { type ReactNode } from "react";
import { type AiProviderModel } from "../../../hooks/collections/use-ai-providers";
import { getProviderLogo } from "@/web/utils/ai-providers-logos";

export type { AiProviderModel } from "../../../hooks/collections/use-ai-providers";

export function parseModelTitle(model: { title: string; modelId: string }): {
  provider: string;
  displayName: string;
} {
  const hasPrefix = model.title.includes(": ");
  return {
    provider: hasPrefix
      ? (model.title.split(": ")[0] ?? "")
      : (model.modelId.split("/")[0] ?? ""),
    displayName: hasPrefix
      ? model.title.split(": ").slice(1).join(": ")
      : model.title,
  };
}

// ============================================================================
// Contextual annotations (absolute thresholds, not relative to model list)
// ============================================================================

// 1–4 context level for dot indicator (absolute thresholds)
function getContextLevel(tokens: number): {
  level: number;
  label: string;
  description: string;
} {
  if (tokens < 32_000) {
    return { level: 1, label: "Small", description: "Short conversations" };
  }
  if (tokens < 200_000) {
    return { level: 2, label: "Medium", description: "Good for most tasks" };
  }
  if (tokens < 500_000) {
    return {
      level: 3,
      label: "Large",
      description: "Long projects & research",
    };
  }
  return { level: 4, label: "Very large", description: "Massive files & data" };
}

// Semantic colors per level — context (more = better: destructive→success)
const CONTEXT_DOT_COLORS = [
  "bg-destructive",
  "bg-warning",
  "bg-success",
  "bg-success",
] as const;

// Semantic colors per level — cost (more = worse: success→destructive)
const COST_DOLLAR_COLORS = [
  "text-success",
  "text-warning",
  "text-warning",
  "text-destructive",
] as const;

// Approximate word count for token amounts
function approxWords(tokens: number): string {
  const k = Math.round((tokens * 0.75) / 1000);
  return k >= 1 ? `~${k}K words` : `~${Math.round(tokens * 0.75)} words`;
}

// 1–4 cost level (absolute thresholds, input $/1M)
function getCostLevel(inputPerM: number): {
  level: number;
  label: string;
} {
  if (inputPerM < 1) return { level: 1, label: "Cheap" };
  if (inputPerM < 5) return { level: 2, label: "Moderate" };
  if (inputPerM < 15) return { level: 3, label: "High" };
  return { level: 4, label: "Expensive" };
}

// ============================================================================
// UI Components
// ============================================================================

const CAPABILITY_CONFIGS: Record<string, { icon: ReactNode; label: string }> = {
  text: { icon: <AlignLeft className="size-3.5" />, label: "Text" },
  vision: { icon: <Image01 className="size-3.5" />, label: "Vision" },
  image: { icon: <ImagePlus className="size-3.5" />, label: "Image" },
  tools: { icon: <Tool01 className="size-3.5" />, label: "Tools" },
  reasoning: { icon: <Stars01 className="size-3.5" />, label: "Reasoning" },
  "web-search": {
    icon: <SearchMd className="size-3.5" />,
    label: "Web search",
  },
};

function CapabilityBadge({ capability }: { capability: string }) {
  const config = CAPABILITY_CONFIGS[capability] ?? {
    icon: null,
    label: capability.charAt(0).toUpperCase() + capability.slice(1),
  };

  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground border border-border rounded px-2 py-0.5">
      {config.icon}
      {config.label}
    </span>
  );
}

export function ModelDetailsPanel({
  model,
  compact = false,
}: {
  model: AiProviderModel | null;
  compact?: boolean;
}) {
  if (!model) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Hover to preview
      </div>
    );
  }

  const inputCostPerM =
    model.costs?.input != null ? model.costs.input * 1_000_000 : null;
  const outputCostPerM =
    model.costs?.output != null ? model.costs.output * 1_000_000 : null;

  const { provider: providerLabel, displayName: modelName } =
    parseModelTitle(model);

  if (compact) {
    return (
      <div className="flex flex-col gap-2 pt-3 pb-3 px-3 text-xs">
        {model.limits?.contextWindow && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Context</span>
            <span className="text-foreground font-medium">
              {model.limits.contextWindow.toLocaleString()} tokens
            </span>
          </div>
        )}
        {inputCostPerM != null && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Input</span>
            <span className="text-foreground font-medium">
              ${inputCostPerM.toFixed(2)} / 1M
            </span>
          </div>
        )}
        {outputCostPerM != null && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Output</span>
            <span className="text-foreground font-medium">
              ${outputCostPerM.toFixed(2)} / 1M
            </span>
          </div>
        )}
        {model.limits?.maxOutputTokens && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Output limit</span>
            <span className="text-foreground font-medium">
              {model.limits.maxOutputTokens.toLocaleString()} tokens
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-1 px-1.5">
      {/* Header */}
      <div className="flex flex-col gap-1 pt-1 pr-6">
        <span className="text-xs font-medium text-muted-foreground">
          {providerLabel}
        </span>
        <div className="flex items-center gap-2.5">
          {model.logo && (
            <img
              src={model.logo}
              className="size-6 shrink-0 rounded-md dark:bg-white dark:rounded-sm dark:p-px"
              alt={model.title}
            />
          )}
          <p className="text-lg font-semibold leading-snug tracking-tight">
            {modelName}
          </p>
        </div>
        <p className="text-xs text-muted-foreground/50 font-mono">
          {model.modelId}
        </p>
      </div>

      {/* Capabilities */}
      {model.capabilities && model.capabilities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-4 border-b border-border">
          {[...new Set(model.capabilities)].map((capability) => (
            <CapabilityBadge key={capability} capability={capability} />
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="flex flex-col gap-6">
        {model.limits?.contextWindow &&
          (() => {
            const { level, label, description } = getContextLevel(
              model.limits.contextWindow,
            );
            return (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Context window
                </span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={cn(
                          "w-2 h-2 rounded-full",
                          i <= level
                            ? CONTEXT_DOT_COLORS[level - 1]
                            : "bg-muted",
                        )}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">
                    {label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    — {description}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {model.limits.contextWindow.toLocaleString()} tokens
                </span>
              </div>
            );
          })()}

        {model.limits?.maxOutputTokens && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Output limit
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-foreground">
                {model.limits.maxOutputTokens.toLocaleString()} tokens
              </span>
              <span className="text-sm text-muted-foreground">
                {approxWords(model.limits.maxOutputTokens)}
              </span>
            </div>
          </div>
        )}

        {(inputCostPerM != null || outputCostPerM != null) &&
          (() => {
            const { level, label } =
              inputCostPerM != null
                ? getCostLevel(inputCostPerM)
                : { level: 0, label: "" };
            return (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Pricing
                </span>
                {inputCostPerM != null && (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center">
                      {[1, 2, 3, 4].map((i) => (
                        <span
                          key={i}
                          className={cn(
                            "text-sm font-bold leading-none",
                            i <= level
                              ? COST_DOLLAR_COLORS[level - 1]
                              : "text-muted-foreground/20",
                          )}
                        >
                          $
                        </span>
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground font-medium">
                      {label}
                    </span>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  {inputCostPerM != null && (
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        Input
                      </span>
                      <span className="text-xs text-foreground">
                        ${inputCostPerM.toFixed(2)} / 1M tokens
                      </span>
                    </div>
                  )}
                  {outputCostPerM != null && (
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        Output
                      </span>
                      <span className="text-xs text-foreground">
                        ${outputCostPerM.toFixed(2)} / 1M tokens
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

export function SelectedModelDisplay({
  model,
  placeholder = "Select model",
  isLoading = false,
}: {
  model: AiProviderModel | null;
  placeholder?: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5">
        <Skeleton className="w-5 h-5 rounded-sm shrink-0" />
        <Skeleton className="w-16 h-3 hidden md:block" />
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-muted-foreground">{placeholder}</span>
        <ChevronDown
          size={14}
          className="text-muted-foreground opacity-50 shrink-0"
        />
      </div>
    );
  }

  const { displayName } = parseModelTitle(model);

  const providerLogo = getProviderLogo(model);

  return (
    <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
      <img
        src={providerLogo}
        className="w-3.5 h-3.5 shrink-0 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
        alt={model.title}
      />
      <span className="text-sm truncate whitespace-nowrap text-muted-foreground max-w-[100px] sm:max-w-none">
        {displayName}
      </span>
      <ChevronDown
        size={14}
        className="text-muted-foreground opacity-50 shrink-0"
      />
    </div>
  );
}

const FILE_BEARING_CAPABILITIES = [
  "vision",
  "image",
  "file",
  "audio",
  "video",
] as const;

const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/**
 * MIME types that no model handles natively but are usable end-to-end
 * via sandbox skills: the model invokes `copy_to_sandbox` to bring the
 * file in, then runs the matching skill (e.g. pptx-extract) to get
 * text/images it can reason over. Allowed whenever the model has any
 * file-bearing capability — text output is universal and thumbnail
 * images need vision, both already covered by the existing checks.
 */
const SKILL_HANDLED_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export function modelSupportsFiles(
  selectedModel: AiProviderModel | null | undefined,
): boolean {
  const caps = selectedModel?.capabilities;
  if (!caps) return false;
  return FILE_BEARING_CAPABILITIES.some((c) => caps.includes(c));
}

export function isFileTypeSupportedByModel(
  mimeType: string,
  selectedModel: AiProviderModel | null | undefined,
): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith("text/")) return true;

  const caps = selectedModel?.capabilities ?? [];
  const hasVision = caps.includes("vision") || caps.includes("image");
  const hasFile = caps.includes("file");
  const hasAudio = caps.includes("audio");
  const hasVideo = caps.includes("video");

  if (hasVision && IMAGE_MIME_TYPES.includes(mimeType as never)) return true;
  if (hasFile && mimeType === "application/pdf") return true;
  if (hasAudio && mimeType.startsWith("audio/")) return true;
  if (hasVideo && mimeType.startsWith("video/")) return true;
  if (
    modelSupportsFiles(selectedModel) &&
    SKILL_HANDLED_MIME_TYPES.includes(mimeType as never)
  ) {
    return true;
  }

  return false;
}

export function getAcceptedMimeTypesForModel(
  selectedModel: AiProviderModel | null | undefined,
): string {
  const caps = selectedModel?.capabilities ?? [];
  const accepted: string[] = ["text/*"];

  if (caps.includes("vision") || caps.includes("image")) {
    accepted.push(...IMAGE_MIME_TYPES);
  }
  if (caps.includes("file")) {
    accepted.push("application/pdf");
  }
  if (caps.includes("audio")) {
    accepted.push("audio/*");
  }
  if (caps.includes("video")) {
    accepted.push("video/*");
  }
  if (modelSupportsFiles(selectedModel)) {
    accepted.push(...SKILL_HANDLED_MIME_TYPES);
  }

  return accepted.join(",");
}

export function getSupportedFileTypesLabel(
  selectedModel: AiProviderModel | null | undefined,
): string {
  const caps = selectedModel?.capabilities ?? [];
  const parts: string[] = [];

  if (caps.includes("vision") || caps.includes("image")) parts.push("images");
  if (caps.includes("file")) parts.push("PDFs");
  if (caps.includes("audio")) parts.push("audio");
  if (caps.includes("video")) parts.push("video");
  if (modelSupportsFiles(selectedModel)) parts.push("Office files");

  if (parts.length === 0) return "text only";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}
