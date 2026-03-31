import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Loading01,
  RefreshCcw01,
  Trash01,
  AlertCircle,
  CheckCircle,
  Tool02,
  ChevronDown,
  ChevronUp,
} from "@untitledui/icons";
import type { RegistryToolMeta } from "@/web/lib/registry/types";
import {
  useDiscoverTools,
  type DiscoverStatus,
} from "@/web/hooks/registry/use-discover-tools";

interface ToolsEditorProps {
  tools: RegistryToolMeta[];
  onChange: (tools: RegistryToolMeta[]) => void;
  remoteUrl?: string;
  remoteType?: string;
  /** Allow passing an external discover state so Step 1 and Step 3 share the same status */
  externalDiscoverStatus?: DiscoverStatus;
  externalDiscoverError?: string | null;
}

export function ToolsEditor({
  tools,
  onChange,
  remoteUrl,
  remoteType,
  externalDiscoverStatus,
  externalDiscoverError,
}: ToolsEditorProps) {
  const [isOpen, setIsOpen] = useState(tools.length > 0);
  const {
    discover,
    discoverStatus: internalStatus,
    discoverError: internalError,
    resetDiscover,
  } = useDiscoverTools();

  const discoverStatus = externalDiscoverStatus ?? internalStatus;
  const discoverError = externalDiscoverError ?? internalError;

  const handleDiscover = async () => {
    if (!remoteUrl) return;
    const discovered = await discover(remoteUrl, remoteType ?? "http");
    if (discovered) {
      onChange(discovered);
      setIsOpen(true);
    }
  };

  const handleClearTools = () => {
    onChange([]);
    resetDiscover();
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium cursor-pointer"
          onClick={() => setIsOpen(!isOpen)}
        >
          <Tool02 size={14} className="text-muted-foreground" />
          <span>Tools</span>
          {tools.length > 0 && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0">
              {tools.length}
            </Badge>
          )}
          {isOpen ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </button>

        <div className="flex items-center gap-2">
          {tools.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1.5 text-muted-foreground"
              onClick={handleClearTools}
            >
              <Trash01 size={12} />
              Clear
            </Button>
          )}
          {remoteUrl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5 border-green-500/30 text-green-600 dark:text-green-400 shadow-[0_0_8px_rgba(34,197,94,0.3)] hover:shadow-[0_0_14px_rgba(34,197,94,0.5)] hover:border-green-500/50 transition-all"
              onClick={handleDiscover}
              disabled={discoverStatus === "loading"}
            >
              {discoverStatus === "loading" ? (
                <Loading01 size={12} className="animate-spin" />
              ) : (
                <RefreshCcw01 size={12} />
              )}
              {discoverStatus === "loading"
                ? "Discovering..."
                : tools.length > 0
                  ? "Refresh"
                  : "Auto-discover"}
            </Button>
          )}
        </div>
      </div>

      {/* Status feedback */}
      {discoverStatus === "success" && (
        <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 rounded-lg px-3 py-2">
          <CheckCircle size={14} className="shrink-0" />
          <span>
            Discovered {tools.length} tool{tools.length !== 1 ? "s" : ""}{" "}
            successfully.
          </span>
        </div>
      )}

      {discoverStatus === "error" && discoverError && (
        <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>{discoverError}</span>
        </div>
      )}

      {/* Tools list */}
      {isOpen && tools.length > 0 && (
        <div className="rounded-xl border border-border divide-y divide-border overflow-hidden max-h-48 overflow-y-auto">
          {tools.map((tool) => (
            <div key={tool.name} className="flex items-center gap-3 px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono truncate">{tool.name}</p>
                {tool.description && (
                  <p className="text-xs text-muted-foreground truncate">
                    {tool.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty hint */}
      {isOpen && tools.length === 0 && discoverStatus === "idle" && (
        <p className="text-xs text-muted-foreground px-1">
          {remoteUrl
            ? 'Click "Auto-discover" to load tools from the MCP server.'
            : "Add a Remote URL first, then tools can be auto-discovered."}
        </p>
      )}
    </div>
  );
}
