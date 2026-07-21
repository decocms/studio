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
import { useT, type TFunction } from "@/web/i18n/use-t.ts";
import type { TranslationKey } from "@/web/i18n/en/index.ts";

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
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
} {
  if (tokens < 32_000) {
    return {
      level: 1,
      labelKey: "chat.shared.contextLevelSmall",
      descriptionKey: "chat.shared.contextLevelSmallDesc",
    };
  }
  if (tokens < 200_000) {
    return {
      level: 2,
      labelKey: "chat.shared.contextLevelMedium",
      descriptionKey: "chat.shared.contextLevelMediumDesc",
    };
  }
  if (tokens < 500_000) {
    return {
      level: 3,
      labelKey: "chat.shared.contextLevelLarge",
      descriptionKey: "chat.shared.contextLevelLargeDesc",
    };
  }
  return {
    level: 4,
    labelKey: "chat.shared.contextLevelVeryLarge",
    descriptionKey: "chat.shared.contextLevelVeryLargeDesc",
  };
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

// ponytail: helpers with dynamic i18n resolution get passed t as param
function approxWords(tokens: number, t: TFunction): string {
  const k = Math.round((tokens * 0.75) / 1000);
  const wordCount = k >= 1 ? `${k}K` : `${Math.round(tokens * 0.75)}`;
  return t("chat.shared.approxWords", { wordCount });
}

// 1–4 cost level (absolute thresholds, input $/1M)
function getCostLevel(inputPerM: number): {
  level: number;
  labelKey: TranslationKey;
} {
  if (inputPerM < 1)
    return { level: 1, labelKey: "chat.shared.costLevelCheap" };
  if (inputPerM < 5)
    return { level: 2, labelKey: "chat.shared.costLevelModerate" };
  if (inputPerM < 15)
    return { level: 3, labelKey: "chat.shared.costLevelHigh" };
  return { level: 4, labelKey: "chat.shared.costLevelExpensive" };
}

// ============================================================================
// UI Components
// ============================================================================

const CAPABILITY_CONFIGS: Record<
  string,
  { icon: ReactNode; labelKey: TranslationKey }
> = {
  text: {
    icon: <AlignLeft className="size-3.5" />,
    labelKey: "chat.shared.capabilityText",
  },
  vision: {
    icon: <Image01 className="size-3.5" />,
    labelKey: "chat.shared.capabilityVision",
  },
  image: {
    icon: <ImagePlus className="size-3.5" />,
    labelKey: "chat.shared.capabilityImage",
  },
  tools: {
    icon: <Tool01 className="size-3.5" />,
    labelKey: "chat.shared.capabilityTools",
  },
  reasoning: {
    icon: <Stars01 className="size-3.5" />,
    labelKey: "chat.shared.capabilityReasoning",
  },
  "web-search": {
    icon: <SearchMd className="size-3.5" />,
    labelKey: "chat.shared.capabilityWebSearch",
  },
};

function CapabilityBadge({ capability }: { capability: string }) {
  const t = useT();
  const config = CAPABILITY_CONFIGS[capability];

  if (config) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground border border-border rounded px-2 py-0.5">
        {config.icon}
        {t(config.labelKey)}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground border border-border rounded px-2 py-0.5">
      {capability.charAt(0).toUpperCase() + capability.slice(1)}
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
  const t = useT();
  if (!model) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t("chat.shared.hoverToPreview")}
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
            <span className="text-muted-foreground">
              {t("chat.shared.context")}
            </span>
            <span className="text-foreground font-medium">
              {model.limits.contextWindow.toLocaleString()}{" "}
              {t("chat.shared.tokens")}
            </span>
          </div>
        )}
        {inputCostPerM != null && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t("chat.shared.input")}
            </span>
            <span className="text-foreground font-medium">
              ${inputCostPerM.toFixed(2)} / 1M
            </span>
          </div>
        )}
        {outputCostPerM != null && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t("chat.shared.output")}
            </span>
            <span className="text-foreground font-medium">
              ${outputCostPerM.toFixed(2)} / 1M
            </span>
          </div>
        )}
        {model.limits?.maxOutputTokens && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t("chat.shared.outputLimit")}
            </span>
            <span className="text-foreground font-medium">
              {model.limits.maxOutputTokens.toLocaleString()}{" "}
              {t("chat.shared.tokens")}
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
            const { level, labelKey, descriptionKey } = getContextLevel(
              model.limits.contextWindow,
            );
            return (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("chat.shared.contextWindow")}
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
                    {t(labelKey)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    — {t(descriptionKey)}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {model.limits.contextWindow.toLocaleString()}{" "}
                  {t("chat.shared.tokens")}
                </span>
              </div>
            );
          })()}

        {model.limits?.maxOutputTokens && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("chat.shared.outputLimit")}
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-foreground">
                {model.limits.maxOutputTokens.toLocaleString()}{" "}
                {t("chat.shared.tokens")}
              </span>
              <span className="text-sm text-muted-foreground">
                {approxWords(model.limits.maxOutputTokens, t)}
              </span>
            </div>
          </div>
        )}

        {(inputCostPerM != null || outputCostPerM != null) &&
          (() => {
            const { level, labelKey } =
              inputCostPerM != null
                ? getCostLevel(inputCostPerM)
                : { level: 0, labelKey: null };
            return (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("chat.shared.pricing")}
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
                      {labelKey ? t(labelKey) : ""}
                    </span>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  {inputCostPerM != null && (
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        {t("chat.shared.input")}
                      </span>
                      <span className="text-xs text-foreground">
                        ${inputCostPerM.toFixed(2)} / 1M{" "}
                        {t("chat.shared.tokens")}
                      </span>
                    </div>
                  )}
                  {outputCostPerM != null && (
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        {t("chat.shared.output")}
                      </span>
                      <span className="text-xs text-foreground">
                        ${outputCostPerM.toFixed(2)} / 1M{" "}
                        {t("chat.shared.tokens")}
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
  placeholder,
  isLoading = false,
}: {
  model: AiProviderModel | null;
  placeholder?: string;
  isLoading?: boolean;
}) {
  const t = useT();
  const resolvedPlaceholder = placeholder ?? t("chat.shared.selectModel");

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
        <span className="text-sm text-muted-foreground">
          {resolvedPlaceholder}
        </span>
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
 * via sandbox skills: the file reaches the sandbox (org/upload with
 * org-fs mounts, copy_to_sandbox otherwise) and the model runs the
 * matching skill (e.g. pptx-extract) to get text/images it can reason
 * over. Allowed whenever the model has any file-bearing capability —
 * text output is universal and thumbnail images need vision, both
 * already covered by the existing checks.
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
): {
  parts: TranslationKey[];
  count: number;
} {
  const caps = selectedModel?.capabilities ?? [];
  const parts: TranslationKey[] = [];

  if (caps.includes("vision") || caps.includes("image"))
    parts.push("chat.shared.fileTypeImages");
  if (caps.includes("file")) parts.push("chat.shared.fileTypePdfs");
  if (caps.includes("audio")) parts.push("chat.shared.fileTypeAudio");
  if (caps.includes("video")) parts.push("chat.shared.fileTypeVideo");
  if (modelSupportsFiles(selectedModel))
    parts.push("chat.shared.fileTypeOffice");

  return { parts, count: parts.length };
}
