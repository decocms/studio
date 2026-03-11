import { Button } from "@deco/ui/components/button.tsx";
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
  ChevronDown,
  ChevronSelectorVertical,
  Image01,
  RefreshCcw01,
  SearchMd,
  Settings01,
  Stars01,
  Tool01,
} from "@untitledui/icons";
import { Suspense, useRef, useState, type ReactNode } from "react";
import {
  useAiProviderKeyList,
  useAiProviderModels,
  useAiProviders,
  type AiProviderModel,
} from "../../hooks/collections/use-llm";
import { ErrorBoundary } from "../error-boundary";
import { useChat } from "./context";

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

  const providerLabel = model.title.includes(": ")
    ? model.title.split(": ")[0]
    : model.modelId.split("/")[0];
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
  const displayName = model.title.includes(": ")
    ? model.title.split(": ").slice(1).join(": ")
    : model.title;
  const provider = model.title.includes(": ")
    ? model.title.split(": ")[0]
    : model.modelId.split("/")[0];

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

function ConnectionModelList({
  keyId,
  onHover,
  onModelSelect,
}: {
  keyId: string | undefined;
  selectedModel?: AiProviderModel | null;
  onModelSelect: (model: AiProviderModel) => void;
  onHover: (model: AiProviderModel) => void;
}) {
  const allModels = useAiProviderModels(keyId);

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {allModels.map((m, i) => {
        const key = m.modelId + i;
        return (
          <div
            key={key}
            onClick={() => onModelSelect(m)}
            className="cursor-pointer"
          >
            <ModelItemContent model={m} onHover={onHover} />
          </div>
        );
      })}
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
  model: AiProviderModel | undefined;
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

export function modelSupportsFiles(
  selectedModel: AiProviderModel | null | undefined,
): boolean {
  return selectedModel?.capabilities?.includes("vision") === true;
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
}: {
  selectedModel?: AiProviderModel | null;
  onModelChange: (model: AiProviderModel) => void;
  onClose: () => void;
}) {
  const [hoveredModel, setHoveredModel] = useState<AiProviderModel | null>(
    null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [managing, setManaging] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const aiProviders = useAiProviders();
  const { credentialId, setCredentialId } = useChat();
  const keys = useAiProviderKeyList();

  const providerMap = Object.fromEntries(
    (aiProviders?.providers ?? []).map((p) => [p.id, p]),
  );

  const handleKeyChange = (keyId: string) => {
    setCredentialId(keyId);
    setHoveredModel(null);
  };

  const handleModelSelect = (model: AiProviderModel) => {
    const credential = credentialId;
    if (!credential) return;
    onModelChange({
      ...model,
      capabilities: model.capabilities ?? [],
      keyId: credential,
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
            {keys.length > 0 && (
              <Select
                value={credentialId ?? ""}
                onValueChange={handleKeyChange}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-[140px] h-8 shrink-0 [&>svg:last-child]:hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue placeholder="Select key" />
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
              onHover={setHoveredModel}
              onModelSelect={handleModelSelect}
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
        <ModelDetailsPanel model={hoveredModel ?? selectedModel ?? null} />
      </div>
    </div>
  );
}

// ============================================================================
// Public Components
// ============================================================================

export interface ModelSelectorProps {
  selectedModel?: AiProviderModel | null;
  onModelChange: (model: AiProviderModel) => void;
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
}

function ResolvedModelDisplay({
  selectedModel,
  placeholder,
}: {
  selectedModel?: AiProviderModel | null;
  placeholder: string;
}) {
  const keyId = selectedModel?.modelId ?? undefined;
  const models = useAiProviderModels(keyId);
  const currentModel = selectedModel
    ? models.find((m) => m.modelId === selectedModel.modelId)
    : undefined;
  return (
    <SelectedModelDisplay model={currentModel} placeholder={placeholder} />
  );
}

function FallbackModelDisplay({
  selectedModel,
  placeholder,
}: {
  selectedModel?: AiProviderModel | null;
  placeholder: string;
}) {
  if (!selectedModel) {
    return <SelectedModelDisplay model={undefined} placeholder={placeholder} />;
  }
  const id = selectedModel.modelId;
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
  variant = "borderless",
  className,
  placeholder = "Select model",
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const currentModel = selectedModel;

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
                selectedModel={currentModel}
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
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
