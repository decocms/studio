import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertTriangle,
  AlignLeft,
  ArrowLeft,
  ChevronDown,
  ChevronSelectorVertical,
  Image01,
  RefreshCcw01,
  SearchMd,
  Settings01,
  Stars01,
  Tool01,
} from "@untitledui/icons";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import type { ChatModelsConfig } from "./types";
import {
  useLLMsFromConnection,
  useModelConnections,
  type LLM,
} from "../../hooks/collections/use-llm";
import { useAllowedModels } from "../../hooks/use-allowed-models";
import { ErrorBoundary } from "../error-boundary";

// ============================================================================
// Tier Classification System
// ============================================================================

const TIER_IDS = ["smarter", "faster", "cheaper"] as const;
type TierId = (typeof TIER_IDS)[number];

const TIER_LABELS: Record<TierId, string> = {
  smarter: "Smarter",
  faster: "Faster",
  cheaper: "Cheaper",
};

const TIER_PATTERNS: Array<{ tier: TierId; prefixes: string[] }> = [
  {
    tier: "smarter",
    prefixes: [
      "anthropic/claude-4.6-opus",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-4.6-sonnet",
      "openai/gpt-5.3-codex",
      "google/gemini-3-pro",
      "google/gemini-2.5-pro",
      "cohere/command-r-plus",
      "cohere/command-a",
    ],
  },
  {
    tier: "faster",
    prefixes: [
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-4.5-haiku",
      "google/gemini-3-flash",
      "openai/gpt-5.1-codex-mini",
      "x-ai/grok-code-fast",
      "x-ai/grok-3",
      "mistralai/mistral-large",
      "mistralai/codestral",
      "mistralai/mistral-medium",
      "qwen/qwen-plus",
      "qwen/qwen-turbo",
      "qwen/qwen3-235b",
      "minimax/minimax-m1",
    ],
  },
  {
    tier: "cheaper",
    prefixes: [
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash",
      "google/gemini-2.0-flash",
      "deepseek/deepseek-v3",
      "openai/gpt-oss-120b",
      "mistralai/mistral-small",
      "mistralai/pixtral",
      "qwen/qwen-long",
      "cohere/command-r",
    ],
  },
];

const FREE_SUFFIX = ":free";

const SORTED_TIER_RULES = TIER_PATTERNS.flatMap(({ tier, prefixes }) =>
  prefixes.map((prefix) => ({ tier, prefix })),
).sort((a, b) => b.prefix.length - a.prefix.length);

// Some prefixes should only match exactly (no sub-variants)
// e.g. "google/gemini-2.5-pro" should NOT match "google/gemini-2.5-pro-preview-05-06"
const EXACT_ONLY_PREFIXES = new Set(["google/gemini-2.5-pro"]);

function classifyModel(modelId: string): TierId | null {
  if (modelId.endsWith(FREE_SUFFIX)) return "cheaper";
  for (const { tier, prefix } of SORTED_TIER_RULES) {
    if (modelId.startsWith(prefix)) {
      // For exact-only prefixes, skip named sub-variants (e.g. -preview) but allow date suffixes (e.g. -20250601)
      if (EXACT_ONLY_PREFIXES.has(prefix) && modelId.length > prefix.length) {
        const nextChar = modelId[prefix.length];
        if (nextChar === "-") {
          const charAfterHyphen = modelId[prefix.length + 1];
          if (!charAfterHyphen || !/\d/.test(charAfterHyphen)) continue;
        }
      }
      return tier;
    }
  }
  return null;
}

const DEFAULT_SHORTLIST = [
  // Smarter
  "anthropic/claude-4.6-opus-20260205",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-4.6-sonnet",
  "anthropic/claude-sonnet-4.6:extended",
  "openai/gpt-5.3-codex",
  "google/gemini-3-pro-preview",
  "google/gemini-2.5-pro",
  // Faster
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4.5-20251001",
  "anthropic/claude-4.5-haiku",
  "google/gemini-3-flash-preview",
  "openai/gpt-5.1-codex-mini",
  "x-ai/grok-code-fast-1",
  // Cheaper
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v3.2",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-oss-120b:free",
];
const defaultShortlistSet = new Set(DEFAULT_SHORTLIST);

const priorityMap = new Map<string, number>();
DEFAULT_SHORTLIST.forEach((id, i) => priorityMap.set(id, i));

// ============================================================================
// localStorage Shortlist Helpers
// ============================================================================

const SHORTLIST_KEY_PREFIX = "mesh:model-shortlist:";

function getShortlist(connectionId: string): string[] | null {
  try {
    const raw = localStorage.getItem(SHORTLIST_KEY_PREFIX + connectionId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setShortlist(connectionId: string, ids: string[]) {
  localStorage.setItem(
    SHORTLIST_KEY_PREFIX + connectionId,
    JSON.stringify(ids),
  );
}

// ============================================================================
// useModels Hook
// ============================================================================

export function useModels(connectionId: string | undefined): LLM[] {
  const models = useLLMsFromConnection(connectionId ?? undefined, {
    pageSize: 999,
  });

  const filteredModels = models.filter(
    (m) => m.limits?.contextWindow && m.limits?.maxOutputTokens,
  );

  return filteredModels.sort((a, b) => {
    const aPriority = priorityMap.get(a.id);
    const bPriority = priorityMap.get(b.id);
    if (aPriority !== undefined && bPriority !== undefined)
      return aPriority - bPriority;
    if (aPriority !== undefined) return -1;
    if (bPriority !== undefined) return 1;
    return a.title.localeCompare(b.title);
  });
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
  if (tokens < 32_000)
    return { level: 1, label: "Small", description: "Short conversations" };
  if (tokens < 200_000)
    return { level: 2, label: "Medium", description: "Good for most tasks" };
  if (tokens < 500_000)
    return {
      level: 3,
      label: "Large",
      description: "Long projects & research",
    };
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
function getCostLevel(inputPerM: number): { level: number; label: string } {
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

function ModelDetailsPanel({
  model,
  compact = false,
}: {
  model: LLM | null;
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

  const providerLabel = model.title.includes(": ")
    ? model.title.split(": ")[0]
    : (model.provider ?? model.id.split("/")[0]);
  const modelName = model.title.includes(": ")
    ? model.title.split(": ").slice(1).join(": ")
    : model.title;

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
              className="size-6 shrink-0 rounded-md"
              alt={model.title}
            />
          )}
          <p className="text-lg font-semibold leading-snug tracking-tight">
            {modelName}
          </p>
        </div>
        <p className="text-xs text-muted-foreground/50 font-mono">{model.id}</p>
      </div>

      {/* Capabilities */}
      {model.capabilities && model.capabilities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-4 border-b border-border">
          {model.capabilities.map((capability) => (
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

function ModelItemContent({
  model,
  onHover,
}: {
  model: LLM;
  onHover: (model: LLM) => void;
}) {
  const displayName = model.title.includes(": ")
    ? model.title.split(": ").slice(1).join(": ")
    : model.title;
  const provider = model.title.includes(": ")
    ? model.title.split(": ")[0]
    : (model.provider ?? model.id.split("/")[0]);

  return (
    <div
      className="flex items-center gap-2.5 py-2 px-3 hover:bg-accent cursor-pointer rounded-lg"
      onMouseEnter={() => onHover(model)}
    >
      {model.logo && (
        <img
          src={model.logo}
          className="w-4 h-4 shrink-0 rounded-sm"
          alt={model.title}
        />
      )}
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-sm text-foreground leading-tight truncate">
          {displayName}
        </span>
        <span className="text-xs text-muted-foreground/60 leading-tight">
          {provider}
        </span>
      </div>
    </div>
  );
}

function ModelListErrorFallback({
  error,
  onRetry,
  connectionId,
  orgSlug,
}: {
  error: Error | null;
  onRetry: () => void;
  connectionId: string | null;
  orgSlug?: string;
}) {
  const navigate = useNavigate();
  const handleConfigure = () => {
    if (!connectionId || !orgSlug) return;
    navigate({
      to: "/$org/$project/mcps/$connectionId",
      params: {
        org: orgSlug,
        project: ORG_ADMIN_PROJECT_SLUG,
        connectionId,
      },
    });
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <div className="bg-destructive/10 p-2 rounded-full">
        <AlertTriangle className="size-5 text-destructive" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          Failed to load models
        </p>
        <p className="text-xs text-muted-foreground max-w-[260px]">
          {error?.message || "Could not fetch models from this provider."}
          {" Try another provider or retry."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="gap-1.5"
        >
          <RefreshCcw01 className="size-3.5" />
          Retry
        </Button>
        {connectionId && orgSlug && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleConfigure}
            className="gap-1.5"
          >
            <Settings01 className="size-3.5" />
            Configure
          </Button>
        )}
      </div>
    </div>
  );
}

function ModelListSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-2 min-h-8 py-3 px-3 rounded-lg"
        >
          <Skeleton className="size-5 shrink-0 rounded-sm" />
          <Skeleton className="flex-1 h-4" />
          <Skeleton className="w-16 h-5 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// ConnectionModelList — browse + manage modes
// ============================================================================

function ConnectionModelList({
  connectionId,
  allowAll,
  isModelAllowed,
  searchTerm,
  selectedModel,
  onModelSelect,
  onHover,
  managing,
  onToggleManage,
  allModelsRef,
  onSelectedModelResolved,
}: {
  connectionId: string | null;
  allowAll: boolean;
  isModelAllowed: (connectionId: string, modelId: string) => boolean;
  searchTerm: string;
  selectedModel?: SelectedModelState;
  onModelSelect: (model: LLM) => void;
  onHover: (model: LLM) => void;
  managing: boolean;
  onToggleManage: () => void;
  allModelsRef: React.RefObject<LLM[]>;
  onSelectedModelResolved: (model: LLM | null) => void;
}) {
  const allModels = useModels(connectionId ?? undefined);
  allModelsRef.current = allModels;

  // Resolve the selected model for the details panel default
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (selectedModel && allModels.length > 0) {
      const found =
        allModels.find((m) => m.id === selectedModel.thinking.id) ?? null;
      if (found) {
        onSelectedModelResolved(found);
      }
    }
  }, [selectedModel, allModels, onSelectedModelResolved]);

  const models = allowAll
    ? allModels
    : allModels.filter(
        (m) => connectionId && isModelAllowed(connectionId, m.id),
      );

  const [shortlistVersion, setShortlistVersion] = useState(0);
  void shortlistVersion;

  const shortlist = connectionId ? getShortlist(connectionId) : null;
  const shortlistSet = shortlist ? new Set(shortlist) : defaultShortlistSet;

  const groupByTier = (list: LLM[]) => {
    const groups: Record<TierId | "other", LLM[]> = {
      smarter: [],
      faster: [],
      cheaper: [],
      other: [],
    };
    for (const m of list) {
      const tier = classifyModel(m.id);
      groups[tier ?? "other"].push(m);
    }
    // Sort each group alphabetically by title
    for (const key of Object.keys(groups)) {
      groups[key as TierId | "other"].sort((a, b) =>
        a.title.localeCompare(b.title),
      );
    }
    return groups;
  };

  if (managing) {
    const displayModels = searchTerm.trim()
      ? models.filter((model) => {
          const search = searchTerm.toLowerCase();
          return (
            model.title.toLowerCase().includes(search) ||
            model.provider?.toLowerCase().includes(search)
          );
        })
      : models;

    const grouped = groupByTier(displayModels);

    const handleToggle = (modelId: string) => {
      if (!connectionId) return;
      const current = shortlist ?? [...defaultShortlistSet];
      const next = current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId];
      setShortlist(connectionId, next);
      setShortlistVersion((v) => v + 1);
    };

    const renderManageSection = (label: string, items: LLM[]) => {
      if (items.length === 0) return null;
      return (
        <div key={label}>
          <div className="text-xs font-medium text-muted-foreground px-3 pt-3 pb-1">
            {label}
          </div>
          {items.map((m) => (
            <label
              key={m.id}
              className="flex items-center gap-3 min-h-8 py-2.5 px-3 hover:bg-accent cursor-pointer rounded-lg"
              onMouseEnter={() => onHover(m)}
            >
              <Checkbox
                checked={shortlistSet.has(m.id)}
                onCheckedChange={() => handleToggle(m.id)}
              />
              {m.logo && (
                <img src={m.logo} className="w-5 h-5 shrink-0" alt={m.title} />
              )}
              <span className="text-sm text-foreground flex-1 min-w-0 line-clamp-1">
                {m.title}
              </span>
            </label>
          ))}
        </div>
      );
    };

    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <button
            type="button"
            onClick={onToggleManage}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ArrowLeft size={14} />
            Back
          </button>
          <span className="text-xs text-muted-foreground">
            {models.filter((m) => shortlistSet.has(m.id)).length} selected
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-0.5 pt-1">
          {TIER_IDS.map((tierId) =>
            renderManageSection(TIER_LABELS[tierId], grouped[tierId]),
          )}
          {renderManageSection("Other", grouped.other)}
        </div>
      </div>
    );
  }

  // --- Browse mode ---
  // If no allowed models match the shortlist, skip it and show all allowed models
  const shortlistedCandidates = models.filter((m) => shortlistSet.has(m.id));
  const shortlistedModels =
    shortlistedCandidates.length > 0 ? shortlistedCandidates : models;

  const filteredModels = searchTerm.trim()
    ? shortlistedModels.filter((model) => {
        const search = searchTerm.toLowerCase();
        return (
          model.title.toLowerCase().includes(search) ||
          model.provider?.toLowerCase().includes(search) ||
          model.description?.toLowerCase().includes(search)
        );
      })
    : shortlistedModels;

  if (filteredModels.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-8 gap-3">
        <p className="text-sm text-muted-foreground">No models found</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleManage}
          className="gap-1.5"
        >
          <Settings01 className="size-3.5" />
          Manage models
        </Button>
      </div>
    );
  }

  if (searchTerm.trim().length > 0) {
    return (
      <div className="flex-1 overflow-y-auto p-2">
        {filteredModels.map((m) => {
          const isSelected = m.id === selectedModel?.thinking.id;
          return (
            <div
              key={m.id}
              onClick={() => onModelSelect(m)}
              className={cn("rounded-lg mb-1", isSelected && "bg-accent/50")}
            >
              <ModelItemContent model={m} onHover={onHover} />
            </div>
          );
        })}
      </div>
    );
  }

  const grouped = groupByTier(filteredModels);

  const renderBrowseSection = (label: string, items: LLM[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label}>
        <div className="text-xs font-medium text-muted-foreground px-3 pt-3 pb-1">
          {label}
        </div>
        {items.map((m) => {
          const isSelected = m.id === selectedModel?.thinking.id;
          return (
            <div
              key={m.id}
              onClick={() => onModelSelect(m)}
              className={cn("rounded-lg mb-1", isSelected && "bg-accent/50")}
            >
              <ModelItemContent model={m} onHover={onHover} />
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {TIER_IDS.map((tierId) =>
        renderBrowseSection(TIER_LABELS[tierId], grouped[tierId]),
      )}
      {grouped.other.length > 0 && (
        <>
          <div className="mx-3 my-2 border-t border-border" />
          {renderBrowseSection("Other", grouped.other)}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Display Components
// ============================================================================

function SelectedModelDisplay({
  model,
  placeholder = "Select model",
}: {
  model: LLM | undefined;
  placeholder?: string;
}) {
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

  const displayName = model.title.includes(": ")
    ? model.title.split(": ").slice(1).join(": ")
    : model.title;

  return (
    <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
      {model.logo && (
        <img
          src={model.logo}
          className="w-5 h-5 shrink-0 rounded-sm"
          alt={model.title}
        />
      )}
      <span className="text-sm text-muted-foreground truncate whitespace-nowrap hidden md:inline">
        {displayName}
      </span>
      <ChevronDown
        size={14}
        className="text-muted-foreground opacity-50 shrink-0 hidden md:inline"
      />
    </div>
  );
}

export type SelectedModelState = ChatModelsConfig;

export function modelSupportsFiles(
  selectedModel: SelectedModelState | null | undefined,
): boolean {
  return selectedModel?.thinking?.capabilities?.vision === true;
}

export interface ModelChangePayload {
  id: string;
  connectionId: string;
  provider?: string;
  capabilities?: string[];
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

// ============================================================================
// ModelSelectorContent — fixed size popover, no resize on manage toggle
// ============================================================================

function ModelSelectorContentFallback() {
  return (
    <div className="flex flex-col md:flex-row h-[460px]">
      <div className="flex-1 flex flex-col md:border-r md:w-[420px] md:min-w-[420px]">
        <div className="border-b border-border h-12 bg-background/95 backdrop-blur sticky top-0 z-10">
          <div className="flex items-center gap-2.5 h-12 px-4">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="flex-1 h-6" />
            <Skeleton className="w-[140px] h-8 shrink-0" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-2 min-h-8 py-3 px-3 rounded-lg"
            >
              <Skeleton className="size-5 shrink-0 rounded-sm" />
              <Skeleton className="flex-1 h-4" />
              <Skeleton className="w-16 h-5 shrink-0 rounded-md" />
            </div>
          ))}
        </div>
      </div>
      <div className="hidden md:block md:w-[320px] md:shrink-0 p-3">
        <div className="flex flex-col gap-3 py-1 px-1.5">
          <div className="flex flex-col gap-3 py-2 px-0">
            <div className="flex items-center gap-3 min-w-0">
              <Skeleton className="size-6 shrink-0" />
              <Skeleton className="h-6 w-32" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-20 rounded-md" />
              <Skeleton className="h-6 w-24 rounded-md" />
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelSelectorContent({
  selectedModel,
  onModelChange,
  onClose,
  modelsConnections: modelsConnectionsProp,
}: {
  selectedModel?: SelectedModelState;
  onModelChange: (model: ModelChangePayload) => void;
  onClose: () => void;
  modelsConnections?: ReturnType<typeof useModelConnections>;
}) {
  const [hoveredModel, setHoveredModel] = useState<LLM | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [managing, setManaging] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const allModelsRef = useRef<LLM[]>([]);

  // The resolved selected model — set by ConnectionModelList once models load
  const [resolvedSelectedModel, setResolvedSelectedModel] =
    useState<LLM | null>(null);

  const { org } = useProjectContext();

  const modelsConnectionsFromHook = useModelConnections();
  const allModelsConnections =
    modelsConnectionsProp ?? modelsConnectionsFromHook;

  const { isModelAllowed, allowAll, hasConnectionModels } = useAllowedModels();

  const modelsConnections = allowAll
    ? allModelsConnections
    : allModelsConnections.filter((conn) => hasConnectionModels(conn.id));

  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(selectedModel?.connectionId ?? modelsConnections[0]?.id ?? null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
  }, []);

  const handleConnectionChange = (connectionId: string) => {
    setSelectedConnectionId(connectionId);
    setHoveredModel(null);
  };

  const handleModelSelect = (model: LLM) => {
    if (!selectedConnectionId) return;
    onModelChange({
      id: model.id,
      connectionId: selectedConnectionId,
      provider: model.provider ?? undefined,
      capabilities: model.capabilities,
      limits: model.limits ?? undefined,
    });
    setSearchTerm("");
    onClose();
  };

  return (
    <div className="flex flex-col md:flex-row h-[460px]">
      <div className="flex-1 flex flex-col md:border-r md:w-[420px] md:min-w-[420px]">
        <div className="border-b border-border h-12 bg-background/95 backdrop-blur sticky top-0 z-10">
          <label className="flex items-center gap-2.5 h-12 px-4 cursor-text">
            <SearchMd size={16} className="text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={
                managing ? "Search all models..." : "Search for a model..."
              }
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 border-0 shadow-none focus-visible:ring-0 px-0 h-full text-sm placeholder:text-muted-foreground/50 bg-transparent"
            />
            {modelsConnections.length > 0 && (
              <Select
                value={selectedConnectionId ?? ""}
                onValueChange={handleConnectionChange}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-[140px] h-8 shrink-0 [&>svg:last-child]:hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue placeholder="Select connection" />
                  <ChevronSelectorVertical className="size-4 opacity-50 shrink-0 pointer-events-none" />
                </SelectTrigger>
                <SelectContent>
                  {modelsConnections.map((conn) => (
                    <SelectItem key={conn.id} value={conn.id}>
                      <div className="flex items-center gap-2">
                        {conn.icon ? (
                          <img
                            src={conn.icon}
                            alt={conn.title}
                            className="w-4 h-4 rounded"
                          />
                        ) : (
                          <div className="w-4 h-4 rounded bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                            {conn.title.slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <span>{conn.title}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </label>
        </div>

        <ErrorBoundary
          key={selectedConnectionId}
          fallback={({ error, resetError }) => (
            <ModelListErrorFallback
              error={error}
              onRetry={resetError}
              connectionId={selectedConnectionId}
              orgSlug={org.slug}
            />
          )}
        >
          <Suspense fallback={<ModelListSkeleton />}>
            <ConnectionModelList
              connectionId={selectedConnectionId}
              allowAll={allowAll}
              isModelAllowed={isModelAllowed}
              searchTerm={searchTerm}
              selectedModel={selectedModel}
              onModelSelect={handleModelSelect}
              onHover={setHoveredModel}
              managing={managing}
              onToggleManage={() => setManaging((v) => !v)}
              allModelsRef={allModelsRef}
              onSelectedModelResolved={setResolvedSelectedModel}
            />
          </Suspense>
        </ErrorBoundary>
        {!managing && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setManaging(true)}
              className="flex items-center gap-2 w-full px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <Settings01 className="size-3.5 shrink-0" />
              Manage models
            </button>
          </div>
        )}
      </div>

      <div className="hidden md:flex md:flex-col md:w-[320px] md:shrink-0 p-3">
        <ModelDetailsPanel model={hoveredModel ?? resolvedSelectedModel} />
      </div>
    </div>
  );
}

// ============================================================================
// Public Components
// ============================================================================

export interface ModelSelectorProps {
  selectedModel?: SelectedModelState;
  onModelChange: (model: ModelChangePayload) => void;
  modelsConnections?: ReturnType<typeof useModelConnections>;
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
}

function ResolvedModelDisplay({
  selectedModel,
  placeholder,
}: {
  selectedModel?: SelectedModelState;
  placeholder: string;
}) {
  const connectionId = selectedModel?.connectionId ?? undefined;
  const models = useModels(connectionId);
  const currentModel = selectedModel
    ? models.find((m) => m.id === selectedModel.thinking.id)
    : undefined;
  return (
    <SelectedModelDisplay model={currentModel} placeholder={placeholder} />
  );
}

function FallbackModelDisplay({
  selectedModel,
  placeholder,
}: {
  selectedModel?: SelectedModelState;
  placeholder: string;
}) {
  if (!selectedModel) {
    return <SelectedModelDisplay model={undefined} placeholder={placeholder} />;
  }
  const id = selectedModel.thinking.id;
  const shortName = id.split("/").pop() ?? id;
  return (
    <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
      <span className="text-sm text-muted-foreground truncate whitespace-nowrap hidden md:inline">
        {shortName}
      </span>
      <ChevronDown
        size={14}
        className="text-muted-foreground opacity-50 shrink-0 hidden md:inline"
      />
    </div>
  );
}

export function ModelSelector({
  selectedModel,
  onModelChange,
  modelsConnections: modelsConnectionsProp,
  variant = "borderless",
  className,
  placeholder = "Select model",
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const modelsConnectionsFromHook = useModelConnections();
  const modelsConnections = modelsConnectionsProp ?? modelsConnectionsFromHook;

  if (modelsConnections.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={variant === "borderless" ? "ghost" : "outline"}
          size="sm"
          className={cn(
            "text-sm hover:bg-accent rounded-lg py-0.5 px-1 gap-1 shadow-none cursor-pointer border-0 group focus-visible:ring-0 focus-visible:ring-offset-0 min-w-0 shrink justify-start overflow-hidden",
            variant === "borderless" && "md:border-none",
            className,
          )}
        >
          <ErrorBoundary
            fallback={
              <FallbackModelDisplay
                selectedModel={selectedModel}
                placeholder={placeholder}
              />
            }
          >
            <Suspense
              fallback={
                <SelectedModelDisplay
                  model={undefined}
                  placeholder={placeholder}
                />
              }
            >
              <ResolvedModelDisplay
                selectedModel={selectedModel}
                placeholder={placeholder}
              />
            </Suspense>
          </ErrorBoundary>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="p-0 gap-0 sm:max-w-fit overflow-hidden"
        closeButtonClassName="top-3.5 right-3.5 z-20"
      >
        <DialogTitle className="sr-only">Select model</DialogTitle>
        <Suspense fallback={<ModelSelectorContentFallback />}>
          <ModelSelectorContent
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            onClose={() => setOpen(false)}
            modelsConnections={modelsConnections}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
