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
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
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
  ImagePlus,
  Key01,
  RefreshCcw01,
  SearchMd,
  Settings01,
  Stars01,
  Tool01,
} from "@untitledui/icons";
import {
  type ReactNode,
  startTransition,
  Suspense,
  useRef,
  useState,
  useTransition,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type AiProviderModel,
  useAiProviderKeyList,
  useAiProviderModels,
  useAiProviders,
} from "../../hooks/collections/use-llm";
import { ErrorBoundary } from "../error-boundary";
import { useChat } from "./context";
import { getProviderLogo } from "@/web/utils/ai-providers-logos";
import { useSettingsModal } from "@/web/hooks/use-settings-modal";
import { NoLlmBindingEmptyState } from "./no-llm-binding-empty-state";

function parseModelTitle(model: { title: string; modelId: string }): {
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
// Tier Classification
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
      "cohere/command-r",
    ],
  },
];

// Sort rules longest-prefix-first for specificity
const SORTED_TIER_RULES = TIER_PATTERNS.flatMap(({ tier, prefixes }) =>
  prefixes.map((prefix) => ({ tier, prefix })),
).sort((a, b) => b.prefix.length - a.prefix.length);

// Only exact matches (no named sub-variants); date suffixes (digits) are fine
const EXACT_ONLY_PREFIXES = new Set(["google/gemini-2.5-pro"]);

const tierCache = new Map<string, TierId | null>();

function classifyModel(modelId: string): TierId | null {
  const cached = tierCache.get(modelId);
  if (cached !== undefined) return cached;

  let result: TierId | null = null;
  if (modelId.endsWith(":free")) {
    result = "cheaper";
  } else {
    outer: for (const { tier, prefix } of SORTED_TIER_RULES) {
      if (modelId.startsWith(prefix)) {
        if (EXACT_ONLY_PREFIXES.has(prefix) && modelId.length > prefix.length) {
          const nextChar = modelId[prefix.length];
          if (nextChar === "-") {
            const charAfterHyphen = modelId[prefix.length + 1];
            if (!charAfterHyphen || !/\d/.test(charAfterHyphen)) continue outer;
          }
        }
        result = tier;
        break;
      }
    }
  }

  tierCache.set(modelId, result);
  return result;
}

function groupByTier(
  models: AiProviderModel[],
): Record<TierId | "other", AiProviderModel[]> {
  const groups: Record<TierId | "other", AiProviderModel[]> = {
    smarter: [],
    faster: [],
    cheaper: [],
    other: [],
  };
  for (const m of models) {
    const tier = classifyModel(m.modelId);
    groups[tier ?? "other"].push(m);
  }
  for (const key of Object.keys(groups) as Array<TierId | "other">) {
    groups[key].sort((a, b) => a.title.localeCompare(b.title));
  }
  return groups;
}

// ============================================================================
// Model Shortlist (localStorage)
// ============================================================================

const SHORTLIST_KEY_PREFIX = "mesh:model-shortlist:";

const DEFAULT_SHORTLIST = new Set([
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
]);

function readShortlist(keyId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(SHORTLIST_KEY_PREFIX + keyId);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeShortlist(keyId: string, ids: Set<string>) {
  localStorage.setItem(SHORTLIST_KEY_PREFIX + keyId, JSON.stringify([...ids]));
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
  "image-generation": {
    icon: <ImagePlus className="size-3.5" />,
    label: "Image generation",
  },
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
              className="size-6 shrink-0 rounded-md"
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

function ModelItemContent({
  model,
  onHover,
}: {
  model: AiProviderModel;
  onHover: (model: AiProviderModel) => void;
}) {
  const { displayName, provider } = parseModelTitle(model);

  const providerLogo = getProviderLogo(model);

  return (
    <div
      className="flex items-center gap-2.5 py-2 px-3 hover:bg-accent cursor-pointer rounded-lg"
      onMouseEnter={() => onHover(model)}
    >
      <img
        src={providerLogo}
        className="w-4 h-4 shrink-0 rounded-sm"
        alt={model.title}
      />
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
}: {
  error: Error | null;
  onRetry: () => void;
  credentialId: string | undefined;
  orgSlug?: string;
}) {
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

function ModelTierSection({
  label,
  models,
  onSelect,
  onHover,
}: {
  label: string;
  models: AiProviderModel[];
  onSelect: (m: AiProviderModel) => void;
  onHover: (m: AiProviderModel) => void;
}) {
  if (models.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground px-3 pt-3 pb-1">
        {label}
      </div>
      {models.map((m) => (
        <div
          key={m.modelId}
          onClick={() => onSelect(m)}
          className="cursor-pointer"
        >
          <ModelItemContent model={m} onHover={onHover} />
        </div>
      ))}
    </div>
  );
}

// Each row is its own component so the React Compiler can memoize them
// individually — only the toggled item re-renders, not all 500.
function ManageModelItem({
  model,
  isChecked,
  onToggle,
  onHover,
}: {
  model: AiProviderModel;
  isChecked: boolean;
  onToggle: (modelId: string) => void;
  onHover: (m: AiProviderModel) => void;
}) {
  // Local state gives instant visual feedback; parent shortlistSet updates
  // asynchronously via startTransition so it never blocks the checkbox.
  const [checked, setChecked] = useState(isChecked);
  if (checked !== isChecked) {
    setChecked(isChecked);
  }
  const logo = getProviderLogo(model);

  return (
    <label
      className="flex items-center gap-3 min-h-8 py-2.5 px-3 hover:bg-accent cursor-pointer rounded-lg"
      onMouseEnter={() => onHover(model)}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={() => {
          setChecked((v) => !v);
          onToggle(model.modelId);
        }}
      />
      <img
        src={logo}
        className="w-5 h-5 shrink-0 rounded-sm"
        alt={model.title}
      />
      <span className="text-sm text-foreground flex-1 min-w-0 line-clamp-1">
        {model.title}
      </span>
    </label>
  );
}

type ManageVirtualItem =
  | { type: "header"; label: string }
  | { type: "model"; model: AiProviderModel };

function buildManageItems(
  grouped: Record<TierId | "other", AiProviderModel[]>,
): ManageVirtualItem[] {
  const items: ManageVirtualItem[] = [];
  for (const tierId of TIER_IDS) {
    if (grouped[tierId].length > 0) {
      items.push({ type: "header", label: TIER_LABELS[tierId] });
      for (const m of grouped[tierId]) items.push({ type: "model", model: m });
    }
  }
  if (grouped.other.length > 0) {
    items.push({ type: "header", label: "Other" });
    for (const m of grouped.other) items.push({ type: "model", model: m });
  }
  return items;
}

function VirtualManageList({
  items,
  shortlistSet,
  onToggle,
  onHover,
}: {
  items: ManageVirtualItem[];
  shortlistSet: Set<string>;
  onToggle: (modelId: string) => void;
  onHover: (m: AiProviderModel) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.type === "header" ? 36 : 44),
    overscan: 6,
  });

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vItem) => {
          const item = items[vItem.index];
          if (!item) return null;
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 right-0 top-0 px-0.5"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              {item.type === "header" ? (
                <div className="text-xs font-medium text-muted-foreground px-3 pt-3 pb-1">
                  {item.label}
                </div>
              ) : (
                <ManageModelItem
                  model={item.model}
                  isChecked={shortlistSet.has(item.model.modelId)}
                  onToggle={onToggle}
                  onHover={onHover}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConnectionModelList({
  keyId,
  searchTerm,
  onHover,
  onModelSelect,
  managing,
  onToggleManage,
  imageMode = false,
}: {
  keyId: string | undefined;
  searchTerm: string;
  onModelSelect: (model: AiProviderModel) => void;
  onHover: (model: AiProviderModel) => void;
  managing: boolean;
  onToggleManage: () => void;
  imageMode?: boolean;
}) {
  const { models: rawModels } = useAiProviderModels(keyId);
  const allModels = imageMode
    ? rawModels.filter((m) => m.capabilities?.includes("image-generation"))
    : rawModels;
  const [shortlistSet, setShortlistSet] = useState<Set<string>>(
    () => (keyId ? readShortlist(keyId) : null) ?? DEFAULT_SHORTLIST,
  );
  const [, startShortlistTransition] = useTransition();

  const handleToggle = (modelId: string) => {
    if (!keyId) return;
    // Deferred: ManageModelItem's local state already gave instant feedback,
    // so this heavier reconciliation can happen in a transition.
    startShortlistTransition(() => {
      setShortlistSet((current) => {
        const next = new Set(current);
        if (next.has(modelId)) {
          next.delete(modelId);
        } else {
          next.add(modelId);
        }
        writeShortlist(keyId, next);
        return next;
      });
    });
  };

  const normalizedSearch = searchTerm.toLowerCase().trim();
  const filterModels = (models: AiProviderModel[]) =>
    normalizedSearch
      ? models.filter(
          (m) =>
            m.title.toLowerCase().includes(normalizedSearch) ||
            m.modelId.toLowerCase().includes(normalizedSearch),
        )
      : models;

  if (managing) {
    const grouped = groupByTier(filterModels(allModels));
    const flatItems = buildManageItems(grouped);
    const selectedCount = allModels.filter((m) =>
      shortlistSet.has(m.modelId),
    ).length;

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
            {selectedCount} selected
          </span>
        </div>
        <VirtualManageList
          items={flatItems}
          shortlistSet={shortlistSet}
          onToggle={handleToggle}
          onHover={onHover}
        />
      </div>
    );
  }

  // Browse mode: show shortlisted models (fall back to all if none match)
  const shortlisted = allModels.filter((m) => shortlistSet.has(m.modelId));
  const browseable = shortlisted.length > 0 ? shortlisted : allModels;
  const grouped = groupByTier(filterModels(browseable));

  return (
    <div className="flex-1 overflow-y-auto px-0.5 pt-1 [touch-action:pan-y]">
      {TIER_IDS.map((tierId) => (
        <ModelTierSection
          key={tierId}
          label={TIER_LABELS[tierId]}
          models={grouped[tierId]}
          onSelect={onModelSelect}
          onHover={onHover}
        />
      ))}
      <ModelTierSection
        label="Other"
        models={grouped.other}
        onSelect={onModelSelect}
        onHover={onHover}
      />
    </div>
  );
}

// ============================================================================
// Display Components
// ============================================================================

function SelectedModelDisplay({
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
        className="w-3.5 h-3.5 shrink-0 rounded-sm"
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

export function modelSupportsFiles(
  selectedModel: AiProviderModel | null | undefined,
): boolean {
  return (
    selectedModel?.capabilities?.includes("vision") === true ||
    selectedModel?.capabilities?.includes("image") === true
  );
}

// ============================================================================
// ModelSelectorContent — fixed size popover, no resize on manage toggle
// ============================================================================

function ModelSelectorContentFallback() {
  return (
    <div className="flex flex-col md:flex-row h-full sm:h-[460px] min-h-0">
      <div className="flex-1 flex flex-col md:border-r md:w-[420px] md:min-w-[420px] min-h-0 overflow-hidden">
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

interface ModelSelectorInnerProps {
  onClose: () => void;
  credentialId: string | null;
  onCredentialChange: (id: string | null) => void;
  selectedModel: AiProviderModel | null;
  onModelChange: (model: AiProviderModel) => void;
  imageMode?: boolean;
}

function ModelSelectorInner({
  onClose,
  credentialId,
  onCredentialChange,
  selectedModel,
  onModelChange,
  imageMode = false,
}: ModelSelectorInnerProps) {
  const [hoveredModel, setHoveredModel] = useState<AiProviderModel | null>(
    null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [managing, setManaging] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const aiProviders = useAiProviders();
  const keys = useAiProviderKeyList();

  const providerMap = Object.fromEntries(
    (aiProviders?.providers ?? []).map((p) => [p.id, p]),
  );
  const { open: openSettings } = useSettingsModal();

  const handleKeyChange = (keyId: string) => {
    onCredentialChange(keyId);
    setHoveredModel(null);
  };

  const handleModelSelect = (model: AiProviderModel) => {
    if (!credentialId) return;
    onModelChange(model);
    setSearchTerm("");
    onClose();
  };

  if (keys.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 w-full sm:w-[740px]">
        <NoLlmBindingEmptyState
          title="Connect an AI provider"
          description="Connect to a model provider to unlock AI-powered features."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-full sm:h-[460px] min-h-0">
      <div className="flex-1 flex flex-col md:border-r md:w-[420px] md:min-w-[420px] min-h-0 overflow-hidden">
        <div className="border-b border-border h-12 bg-background/95 backdrop-blur sticky top-0 z-10">
          <label className="flex items-center gap-2.5 h-12 px-4 pr-12 md:pr-4 cursor-text">
            <SearchMd size={16} className="text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={
                managing ? "Search all models..." : "Search for a model..."
              }
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 min-w-0 border-0 shadow-none focus-visible:ring-0 px-0 h-full text-sm placeholder:text-muted-foreground/50 bg-transparent"
            />
            {keys.length > 0 && (
              <Select
                value={credentialId ?? ""}
                onValueChange={handleKeyChange}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto max-w-[140px] h-8 shrink-0 gap-1.5 px-2 [&>svg:last-child]:hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue placeholder="Key">
                    {(() => {
                      const key = keys.find((k) => k.id === credentialId);
                      const provider = key
                        ? providerMap[key.providerId]
                        : undefined;
                      return (
                        <span className="flex items-center gap-1.5 min-w-0">
                          {provider?.logo ? (
                            <img
                              src={provider.logo}
                              alt={provider.name}
                              className="w-4 h-4 rounded shrink-0"
                            />
                          ) : (
                            <div className="w-4 h-4 rounded bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                              {(provider?.name ?? key?.providerId ?? "?")
                                .slice(0, 1)
                                .toUpperCase()}
                            </div>
                          )}
                          <span className="text-xs truncate">
                            {provider?.name ?? key?.providerId ?? "Key"}
                          </span>
                        </span>
                      );
                    })()}
                  </SelectValue>
                  <ChevronSelectorVertical className="size-4 opacity-50 shrink-0 pointer-events-none" />
                </SelectTrigger>
                <SelectContent>
                  {keys.map((key) => {
                    const provider = providerMap[key.providerId];
                    return (
                      <SelectItem key={key.id} value={key.id}>
                        <div className="flex items-center gap-2">
                          {provider?.logo ? (
                            <img
                              src={provider.logo}
                              alt={provider.name}
                              className="w-4 h-4 rounded"
                            />
                          ) : (
                            <div className="w-4 h-4 rounded bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                              {(provider?.name ?? key.providerId)
                                .slice(0, 1)
                                .toUpperCase()}
                            </div>
                          )}
                          <span>
                            {provider?.name ?? key.providerId} — {key.label}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </label>
        </div>

        <ErrorBoundary
          key={credentialId}
          fallback={({ error, resetError }) => (
            <ModelListErrorFallback
              error={error}
              onRetry={resetError}
              credentialId={credentialId ?? undefined}
            />
          )}
        >
          <Suspense fallback={<ModelListSkeleton />}>
            <ConnectionModelList
              keyId={credentialId ?? undefined}
              searchTerm={searchTerm}
              onHover={setHoveredModel}
              onModelSelect={handleModelSelect}
              managing={managing}
              onToggleManage={() => setManaging((v) => !v)}
              imageMode={imageMode}
            />
          </Suspense>
        </ErrorBoundary>
        {!managing && (
          <div className="border-t border-border flex">
            <button
              type="button"
              onClick={() => startTransition(() => setManaging(true))}
              className="flex items-center gap-2 flex-1 px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <Settings01 className="size-3.5 shrink-0" />
              Manage models
            </button>
            <div className="w-px bg-border shrink-0" />
            <button
              type="button"
              onClick={() => openSettings("org.ai-providers")}
              className="flex items-center gap-2 flex-1 px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <Key01 className="size-3.5 shrink-0" />
              Manage API keys
            </button>
          </div>
        )}
      </div>

      <div className="hidden md:flex md:flex-col md:w-[320px] md:shrink-0 p-3">
        <ModelDetailsPanel model={hoveredModel ?? selectedModel ?? null} />
      </div>
    </div>
  );
}

function ModelSelectorContent({ onClose }: { onClose: () => void }) {
  const {
    credentialId,
    setCredentialId,
    model: selectedModel,
    setSelectedModel,
    imageMode,
  } = useChat();

  return (
    <ModelSelectorInner
      onClose={onClose}
      credentialId={credentialId}
      onCredentialChange={setCredentialId}
      selectedModel={selectedModel}
      onModelChange={(model) => {
        if (!credentialId) return;
        setSelectedModel({ ...model, keyId: credentialId });
      }}
      imageMode={imageMode}
    />
  );
}

// ============================================================================
// Public Components
// ============================================================================

export interface ModelSelectorProps {
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
  // Standalone mode (bypasses useChat)
  model?: AiProviderModel | null;
  isLoading?: boolean;
  credentialId?: string | null;
  onCredentialChange?: (id: string | null) => void;
  onModelChange?: (model: AiProviderModel) => void;
}

export function ModelSelector({
  variant = "borderless",
  className,
  placeholder = "Select model",
  model: modelProp,
  isLoading: isLoadingProp,
  credentialId: credentialIdProp,
  onCredentialChange,
  onModelChange,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const standalone = onModelChange !== undefined;
  const isMobile = useIsMobile();

  const triggerButton = (
    <Button
      variant={variant === "borderless" ? "ghost" : "outline"}
      size="sm"
      className={cn(
        "text-sm hover:bg-accent rounded-lg py-0.5 px-1 gap-1 shadow-none cursor-pointer border-0 group focus-visible:ring-0 focus-visible:ring-offset-0 min-w-0 shrink justify-start overflow-hidden",
        variant === "borderless" && "md:border-none",
        className,
      )}
    >
      {standalone ? (
        <SelectedModelDisplay
          model={modelProp ?? null}
          placeholder={placeholder}
          isLoading={isLoadingProp}
        />
      ) : (
        <ModelSelectorTriggerContent placeholder={placeholder} />
      )}
    </Button>
  );

  const selectorContent = (
    <Suspense fallback={<ModelSelectorContentFallback />}>
      {standalone ? (
        <ModelSelectorInner
          onClose={() => setOpen(false)}
          credentialId={credentialIdProp ?? null}
          onCredentialChange={onCredentialChange ?? (() => {})}
          selectedModel={modelProp ?? null}
          onModelChange={onModelChange}
        />
      ) : (
        <ModelSelectorContent onClose={() => setOpen(false)} />
      )}
    </Suspense>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent className="p-0 flex flex-col max-h-[95vh]">
          <DrawerTitle className="sr-only">Select model</DrawerTitle>
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {selectorContent}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{triggerButton}</DialogTrigger>
      <DialogContent
        className="p-0 gap-0 sm:max-w-fit overflow-hidden h-[100dvh] sm:h-auto max-h-[100dvh] sm:max-h-[85vh] w-full max-w-full sm:max-w-fit rounded-none sm:rounded-xl border-0 sm:border"
        closeButtonClassName="top-3.5 right-3.5 z-20"
      >
        <DialogTitle className="sr-only">Select model</DialogTitle>
        {selectorContent}
      </DialogContent>
    </Dialog>
  );
}

function ModelSelectorTriggerContent({ placeholder }: { placeholder: string }) {
  const { model, isModelsLoading } = useChat();
  return (
    <SelectedModelDisplay
      model={model}
      placeholder={placeholder}
      isLoading={isModelsLoading}
    />
  );
}
