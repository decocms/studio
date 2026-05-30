import { cn } from "@deco/ui/lib/utils.ts";
import { IntegrationIcon } from "@/web/components/integration-icon";
import type { JsonSchema } from "@/web/utils/constants";
import { usePrioritizedList } from "../hooks";
import {
  useCurrentStep,
  useSelectedVirtualMcpId,
  useWorkflowActions,
} from "../stores/workflow";
import {
  getDecopilotId,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Spinner } from "@deco/ui/components/spinner.tsx";

interface ToolSidebarProps {
  className?: string;
}

/**
 * Hook to get tools from the selected virtual MCP (agent).
 * Falls back to Decopilot (passthrough) when no agent is selected,
 * which exposes all tools available in the organization.
 */
function useVirtualMCPTools() {
  const { org } = useProjectContext();
  const selectedId = useSelectedVirtualMcpId();
  const virtualMcpId = selectedId ?? getDecopilotId(org.id);

  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const toolsQuery = useMCPToolsListQuery({ client });

  return {
    tools: toolsQuery.data?.tools ?? [],
    isLoading: toolsQuery.isLoading,
    error: toolsQuery.error,
  };
}

export function ToolSidebar({ className }: ToolSidebarProps) {
  return <ToolSelector className={className} />;
}

// ============================================================================
// Tool Selector
// ============================================================================

function ToolSelector({ className }: { className?: string }) {
  const { tools, isLoading, error } = useVirtualMCPTools();
  const currentStep = useCurrentStep();
  const { updateStep } = useWorkflowActions();

  const isToolStep = currentStep && "toolName" in currentStep.action;
  const selectedToolName =
    isToolStep && "toolName" in currentStep.action
      ? currentStep.action.toolName
      : null;

  const selectedTool = tools.find((t) => t.name === selectedToolName);

  const prioritizedTools = usePrioritizedList(
    tools,
    selectedTool ?? null,
    (t) => t.name,
    (a, b) => a.name.localeCompare(b.name),
  );

  const handleSelectTool = (tool: Tool) => {
    if (!currentStep) return;

    updateStep(currentStep.name, {
      action: {
        ...currentStep.action,
        toolName: tool.name,
      },
      // Set the step's outputSchema to the tool's outputSchema
      outputSchema: (tool.outputSchema ?? {}) as JsonSchema,
    });
  };

  if (isLoading) {
    return (
      <div className={cn("flex flex-col h-full bg-sidebar", className)}>
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="sm" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("flex flex-col h-full bg-sidebar", className)}>
        <div className="flex-1 flex items-center justify-center text-sm text-destructive p-4 text-center">
          Failed to load tools: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full bg-sidebar", className)}>
      {/* Header */}
      <div className="flex items-start border-b border-border">
        <div className="flex-1 flex items-center h-12 px-5">
          <span className="text-base font-medium text-foreground">
            Select tool
          </span>
          <span className="ml-2 text-sm text-muted-foreground">
            ({tools.length})
          </span>
        </div>
      </div>

      {/* Tool List */}
      <div className="flex-1 overflow-auto">
        {prioritizedTools.map((tool) => (
          <SidebarRow
            key={tool.name}
            icon={null}
            title={tool.name}
            description={tool.description}
            isSelected={tool.name === selectedToolName}
            onClick={() => handleSelectTool(tool)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Shared Components
// ============================================================================

interface SidebarRowProps {
  icon: string | null;
  title: string;
  description?: string;
  isSelected: boolean;
  onClick: () => void;
}

function SidebarRow({
  icon,
  title,
  description,
  isSelected,
  onClick,
}: SidebarRowProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 min-h-14 px-5 py-4 cursor-pointer transition-colors",
        "hover:bg-muted/50",
        isSelected && "bg-muted/50",
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <IntegrationIcon
        icon={icon}
        name={title}
        size="xs"
        className="shadow-sm mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-foreground truncate block">
          {title}
        </span>
        {description && (
          <span className="text-xs text-muted-foreground line-clamp-2">
            {description}
          </span>
        )}
      </div>
    </div>
  );
}
