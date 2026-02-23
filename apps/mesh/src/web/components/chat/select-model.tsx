import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
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
  ChevronDown,
  ChevronSelectorVertical,
  CurrencyDollar,
  File06,
  Grid01,
  Image01,
  LogOut04,
  RefreshCcw01,
  SearchMd,
  Settings01,
  Stars01,
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

// Prioritized models in order
const prioritizedModelIds = [
  "x-ai/grok-code-fast-1",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-2.5-flash",
  "xiaomi/mimo-v2-flash:free",
  "google/gemini-3-flash-preview",
  "deepseek/deepseek-v3.2",
  "anthropic/claude-opus-4.5",
  "x-ai/grok-4.1-fast",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.0-flash-001",
];

// Create a map for quick priority lookup
const priorityMap = new Map<string, number>();
prioritizedModelIds.forEach((modelId, index) => {
  priorityMap.set(modelId, index);
});

/**
 * Hook to fetch LLM models from a specific connection.
 * Returns filtered and sorted models.
 */
export function useModels(connectionId: string | undefined): LLM[] {
  // Fetch models from the connection using the collection hook
  const models = useLLMsFromConnection(connectionId ?? undefined, {
    pageSize: 999,
  });

  // Filter models that have required limits
  const filteredModels = models.filter(
    (m) => m.limits?.contextWindow && m.limits?.maxOutputTokens,
  );

  // Sort models
  return filteredModels.sort((a, b) => {
    // First, check if either model is prioritized
    const aPriority = priorityMap.get(a.id);
    const bPriority = priorityMap.get(b.id);

    // If both are prioritized, sort by priority order
    if (aPriority !== undefined && bPriority !== undefined) {
      return aPriority - bPriority;
    }

    // If only one is prioritized, it comes first
    if (aPriority !== undefined) return -1;
    if (bPriority !== undefined) return 1;

    // If neither is prioritized, sort alphabetically
    return a.title.localeCompare(b.title);
  });
}

const CAPABILITY_CONFIGS: Record<string, { icon: ReactNode; label: string }> = {
  reasoning: {
    icon: <Stars01 className="size-4" />,
    label: "Reasoning",
  },
  "image-upload": {
    icon: <Image01 className="size-4" />,
    label: "Can analyze images",
  },
  "file-upload": {
    icon: <File06 className="size-4" />,
    label: "Can analyze files",
  },
  "web-search": {
    icon: <SearchMd className="size-4" />,
    label: "Can search the web to answer questions",
  },
};

function CapabilityBadge({ capability }: { capability: string }) {
  const config = (() => {
    const knownConfig = CAPABILITY_CONFIGS[capability];
    return (
      knownConfig || {
        icon: null,
        label: capability,
      }
    );
  })();

  const displayLabel = config.label
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  const chartColorVar = `var(--chart-1)`;

  return (
    <div
      className="flex items-center gap-1.5 py-0.5 px-1.5 rounded-md text-xs font-medium"
      style={{
        backgroundColor: `color-mix(in oklch, ${chartColorVar} 15%, transparent)`,
        color: chartColorVar,
      }}
    >
      {config.icon}
      <span>{displayLabel}</span>
    </div>
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

  // Check if model has extended info (contextWindow, costs, etc)
  const hasDetails =
    model.limits?.contextWindow ||
    model.costs?.input ||
    model.costs?.output ||
    model.limits?.maxOutputTokens;

  if (!hasDetails && !compact) {
    return (
      <div className="flex flex-col gap-3 py-1 px-1.5">
        <div className="flex items-center gap-3 py-2 px-0">
          {model.logo && (
            <img src={model.logo} className="w-6 h-6" alt={model.title} />
          )}
          <p className="text-lg font-medium leading-7">{model.title}</p>
        </div>
        {model.description && (
          <p className="text-sm text-muted-foreground">{model.description}</p>
        )}
      </div>
    );
  }

  if (!hasDetails && compact) {
    return null;
  }

  // Compact mobile version - just the details without header
  if (compact) {
    return (
      <div className="flex flex-col gap-2.5 pt-3 pb-3 px-3 rounded-b-lg text-xs">
        {model.limits?.contextWindow && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Context</span>
            <span className="text-foreground font-medium">
              {model.limits.contextWindow.toLocaleString()} tokens
            </span>
          </div>
        )}

        {model.costs?.input && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Input cost</span>
            <span className="text-foreground font-medium">
              ${(model.costs.input * 1_000_000).toFixed(2)} / 1M
            </span>
          </div>
        )}

        {model.costs?.output && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Output cost</span>
            <span className="text-foreground font-medium">
              ${(model.costs.output * 1_000_000).toFixed(2)} / 1M
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

  // Full desktop version with header
  return (
    <div className="flex flex-col gap-3 py-1 px-1.5">
      <div className="flex flex-col gap-3 py-2 px-0">
        <div className="flex items-center gap-3 min-w-0">
          {model.logo && (
            <img
              src={model.logo}
              className="w-6 h-6 shrink-0"
              alt={model.title}
            />
          )}
          <p className="text-lg font-medium leading-7 wrap-break-word min-w-0">
            {model.title}
          </p>
        </div>
        {model.capabilities && model.capabilities.length > 0 && (
          <div className="flex items-center gap-2">
            {model.capabilities.map((capability) => (
              <CapabilityBadge key={capability} capability={capability} />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {model.limits?.contextWindow && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Grid01 className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-sm text-foreground">Context window</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {model.limits.contextWindow.toLocaleString()} tokens
            </p>
          </div>
        )}

        {(model.costs?.input || model.costs?.output) && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <CurrencyDollar className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-sm text-foreground">Costs</p>
            </div>
            <div className="flex flex-col gap-0.5">
              {model.costs?.input !== null &&
                model.costs?.input !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    ${(model.costs.input * 1_000_000).toFixed(2)} / 1M tokens
                    (input)
                  </p>
                )}
              {model.costs?.output !== null &&
                model.costs?.output !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    ${(model.costs.output * 1_000_000).toFixed(2)} / 1M tokens
                    (output)
                  </p>
                )}
            </div>
          </div>
        )}

        {model.limits?.maxOutputTokens && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <LogOut04 className="w-4.5 h-4.5 text-muted-foreground/70" />
              <p className="text-sm text-foreground">Output limit</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {model.limits.maxOutputTokens.toLocaleString()} token limit
            </p>
          </div>
        )}
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
  return (
    <div
      className="flex items-center gap-2 min-h-8 py-3 px-3 hover:bg-accent cursor-pointer rounded-lg"
      onMouseEnter={() => onHover(model)}
    >
      {model.logo && (
        <img src={model.logo} className="w-5 h-5 shrink-0" alt={model.title} />
      )}
      <span className="text-sm text-foreground flex-1 min-w-0 line-clamp-1">
        {model.title}
      </span>
      {model.capabilities && model.capabilities.length > 0 && (
        <div className="flex items-center gap-1.5 shrink-0">
          {model.capabilities.slice(0, 2).map((capability) => (
            <CapabilityBadge key={capability} capability={capability} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Error fallback shown when fetching models from a connection fails.
 * Allows the user to retry or navigate to connection configuration.
 */
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

/**
 * Skeleton loader for the model list area while models are being fetched.
 */
function ModelListSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto px-0.5 pt-2 space-y-1">
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

/**
 * Fetches and renders the model list for a specific connection.
 * Isolated so it can be wrapped with ErrorBoundary + Suspense — when the
 * fetch fails (e.g. no auth), the error boundary catches it and the user
 * can switch to another provider.
 */
function ConnectionModelList({
  connectionId,
  allowAll,
  isModelAllowed,
  searchTerm,
  selectedModel,
  onModelSelect,
  onHover,
}: {
  connectionId: string | null;
  allowAll: boolean;
  isModelAllowed: (connectionId: string, modelId: string) => boolean;
  searchTerm: string;
  selectedModel?: SelectedModelState;
  onModelSelect: (model: LLM) => void;
  onHover: (model: LLM) => void;
}) {
  // This suspense-enabled call can throw if the connection is inaccessible
  const allModels = useModels(connectionId ?? undefined);

  // Filter models based on permissions
  const models = allowAll
    ? allModels
    : allModels.filter(
        (m) => connectionId && isModelAllowed(connectionId, m.id),
      );

  // Filter models based on search term
  const filteredModels = searchTerm.trim()
    ? models.filter((model) => {
        const search = searchTerm.toLowerCase();
        return (
          model.title.toLowerCase().includes(search) ||
          model.provider?.toLowerCase().includes(search) ||
          model.description?.toLowerCase().includes(search)
        );
      })
    : models;

  if (filteredModels.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-8 text-sm text-muted-foreground">
        No models found
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-0.5 pt-2">
      {filteredModels.map((m) => {
        const isSelected = m.id === selectedModel?.thinking.id;
        return (
          <div
            key={m.id}
            onClick={() => onModelSelect(m)}
            className={cn("rounded-lg mb-1", isSelected && "bg-accent")}
          >
            <ModelItemContent model={m} onHover={onHover} />
          </div>
        );
      })}
    </div>
  );
}

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

  return (
    <div className="flex items-center gap-0 group-hover:gap-2 group-data-[state=open]:gap-2 min-w-0 overflow-hidden transition-all duration-200">
      {model.logo && (
        <img
          src={model.logo}
          className="w-5 h-5 shrink-0 rounded-sm"
          alt={model.title}
        />
      )}
      <span className="text-sm text-muted-foreground group-hover:text-foreground group-data-[state=open]:text-foreground truncate whitespace-nowrap max-w-0 opacity-0 group-hover:max-w-[150px] group-hover:opacity-100 group-data-[state=open]:max-w-[150px] group-data-[state=open]:opacity-100 transition-all duration-200 ease-in-out overflow-hidden">
        {model.title}
      </span>
      <ChevronDown
        size={14}
        className="text-muted-foreground opacity-0 max-w-0 group-hover:opacity-50 group-hover:max-w-[14px] group-data-[state=open]:opacity-50 group-data-[state=open]:max-w-[14px] shrink-0 transition-all duration-200 ease-in-out overflow-hidden"
      />
    </div>
  );
}

/**
 * Selected model state shape for controlled components
 * Alias for ChatModelsConfig for backwards compatibility.
 */
export type SelectedModelState = ChatModelsConfig;

/**
 * Check if a model supports file uploads (vision capability)
 */
export function modelSupportsFiles(
  selectedModel: SelectedModelState | null | undefined,
): boolean {
  return selectedModel?.thinking?.capabilities?.vision === true;
}

/**
 * Model change callback payload
 */
export interface ModelChangePayload {
  id: string;
  connectionId: string;
  provider?: string;
  capabilities?: string[];
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

/**
 * Loading state for ModelSelectorContent
 */
function ModelSelectorContentFallback() {
  return (
    <div className="flex flex-col md:flex-row h-[350px]">
      {/* Left column - model list with search */}
      <div className="flex-1 flex flex-col md:border-r md:w-[400px] md:min-w-[400px]">
        {/* Search input skeleton */}
        <div className="border-b border-border h-12 bg-background/95 backdrop-blur sticky top-0 z-10">
          <div className="flex items-center gap-2.5 h-12 px-4">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="flex-1 h-6" />
            <Skeleton className="w-[140px] h-8 shrink-0" />
          </div>
        </div>

        {/* Model list skeleton */}
        <div className="flex-1 overflow-y-auto px-0.5 pt-2 space-y-1">
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
      </div>

      {/* Right column - details panel skeleton (desktop only) */}
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

/**
 * Modal content component for model selection.
 * The model-fetching logic lives in `ConnectionModelList` which is wrapped
 * with ErrorBoundary + Suspense so a failed provider doesn't break the whole
 * selector — the user can switch connections and retry.
 */
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
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { org } = useProjectContext();

  // Use provided modelsConnections or fetch from hook
  const modelsConnectionsFromHook = useModelConnections();
  const allModelsConnections =
    modelsConnectionsProp ?? modelsConnectionsFromHook;

  // Fetch allowed models for current user
  const { isModelAllowed, allowAll, hasConnectionModels } = useAllowedModels();

  // Filter connections to only those with at least one allowed model.
  // This prevents fetching the LLM list from connections the user has no access to,
  // which would show empty states and potentially cause auth errors.
  const modelsConnections = allowAll
    ? allModelsConnections
    : allModelsConnections.filter((conn) => hasConnectionModels(conn.id));

  // Default to the stored connection, or the first available connection so the
  // list (and any error fallback) renders immediately without a manual selection.
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(selectedModel?.connectionId ?? modelsConnections[0]?.id ?? null);

  // Focus search input when mounted
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    // Small delay to ensure the dialog is fully rendered
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
    <div className="flex flex-col md:flex-row h-[350px]">
      {/* Left column - model list with search */}
      <div className="flex-1 flex flex-col md:border-r md:w-[400px] md:min-w-[400px]">
        {/* Search input + connection selector — always visible even on error */}
        <div className="border-b border-border h-12 bg-background/95 backdrop-blur sticky top-0 z-10">
          <label className="flex items-center gap-2.5 h-12 px-4 cursor-text">
            <SearchMd size={16} className="text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search for a model..."
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

        {/* Model list — wrapped in ErrorBoundary so a failed provider
            doesn't break the selector. key={connectionId} resets the
            boundary when the user switches connections. */}
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
            />
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* Right column - details panel (desktop only) */}
      <div className="hidden md:block md:w-[320px] md:shrink-0 p-3">
        <ModelDetailsPanel model={hoveredModel} />
      </div>
    </div>
  );
}

export interface ModelSelectorProps {
  selectedModel?: SelectedModelState;
  onModelChange: (model: ModelChangePayload) => void;
  modelsConnections?: ReturnType<typeof useModelConnections>;
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
}

/**
 * Resolves the selected model's display info (name, logo) by fetching the
 * model list. Extracted so it can be wrapped with Suspense/ErrorBoundary
 * independently of the trigger button.
 */
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

/**
 * Fallback trigger display when the model list can't be resolved.
 * Shows the short model name extracted from the ID.
 */
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

  // Show short model name from the ID (e.g. "claude-sonnet-4.5" from "anthropic/claude-sonnet-4.5")
  const id = selectedModel.thinking.id;
  const shortName = id.split("/").pop() ?? id;
  return (
    <div className="flex items-center gap-0 group-hover:gap-2 group-data-[state=open]:gap-2 min-w-0 overflow-hidden transition-all duration-200">
      <span className="text-sm text-muted-foreground group-hover:text-foreground group-data-[state=open]:text-foreground truncate whitespace-nowrap max-w-0 opacity-0 group-hover:max-w-[150px] group-hover:opacity-100 group-data-[state=open]:max-w-[150px] group-data-[state=open]:opacity-100 transition-all duration-200 ease-in-out overflow-hidden">
        {shortName}
      </span>
      <ChevronDown
        size={14}
        className="text-muted-foreground opacity-0 max-w-0 group-hover:opacity-50 group-hover:max-w-[14px] group-data-[state=open]:opacity-50 group-data-[state=open]:max-w-[14px] shrink-0 transition-all duration-200 ease-in-out overflow-hidden"
      />
    </div>
  );
}

/**
 * Rich model selector with detailed info panel, capabilities badges, and responsive UI.
 * Fetches models internally from the connected LLM provider.
 */
export function ModelSelector({
  selectedModel,
  onModelChange,
  modelsConnections: modelsConnectionsProp,
  variant = "borderless",
  className,
  placeholder = "Select model",
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  // Use provided modelsConnections or fetch from hook
  const modelsConnectionsFromHook = useModelConnections();
  const modelsConnections = modelsConnectionsProp ?? modelsConnectionsFromHook;

  if (modelsConnections.length === 0) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={variant === "borderless" ? "ghost" : "outline"}
          size="sm"
          className={cn(
            "text-sm hover:bg-accent rounded-lg py-0.5 px-1 gap-1 shadow-none cursor-pointer border-0 group focus-visible:ring-0 focus-visible:ring-offset-0 min-w-0 shrink justify-start overflow-hidden",
            variant === "borderless" && "md:border-none",
            className,
          )}
        >
          {/* Resolve model display info — falls back gracefully on error */}
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
      </PopoverTrigger>
      <PopoverContent
        className="w-full md:w-auto p-0"
        align="start"
        side="bottom"
        sideOffset={8}
      >
        <Suspense fallback={<ModelSelectorContentFallback />}>
          <ModelSelectorContent
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            onClose={() => setOpen(false)}
            modelsConnections={modelsConnections}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
