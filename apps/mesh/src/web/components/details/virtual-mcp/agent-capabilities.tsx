import { ErrorBoundary } from "@/web/components/error-boundary";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { ToolAnnotationBadges } from "@/web/components/tools";
import {
  useConnection,
  useMCPClient,
  useMCPToolsList,
  useMCPResourcesList,
  useMCPPromptsList,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { cn } from "@deco/ui/lib/utils.ts";
import { CubeOutline, File02, Tool01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import type { VirtualMCPConnection } from "@decocms/mesh-sdk/types";

interface AgentCapabilitiesProps {
  connections: VirtualMCPConnection[];
}

interface CapabilityItem {
  name: string;
  description?: string;
  connectionId: string;
  tags?: React.ReactNode;
}

type CapabilityFilter = "tools" | "resources" | "prompts";

const FILTER_OPTIONS: {
  value: CapabilityFilter;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
}[] = [
  { value: "tools", label: "Tools", Icon: Tool01 },
  { value: "resources", label: "Resources", Icon: CubeOutline },
  { value: "prompts", label: "Prompts", Icon: File02 },
];

/**
 * Small connection icon badge shown next to each capability item
 */
function SourceBadge({ connectionId }: { connectionId: string }) {
  const connection = useConnection(connectionId);
  if (!connection) return null;

  return (
    <IntegrationIcon
      icon={connection.icon}
      name={connection.title}
      size="xs"
      className="shrink-0 opacity-50 mt-0.5"
    />
  );
}

function CapabilityRow({ item }: { item: CapabilityItem }) {
  return (
    <div className="flex items-start gap-3 px-3 py-3 rounded-lg hover:bg-muted/40 transition-colors group">
      <Suspense
        fallback={
          <div className="size-4 rounded bg-muted animate-pulse shrink-0 mt-0.5" />
        }
      >
        <SourceBadge connectionId={item.connectionId} />
      </Suspense>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-sm font-medium font-mono leading-none tracking-tight">
            {item.name}
          </span>
          {item.tags && <span className="shrink-0">{item.tags}</span>}
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {item.description}
          </p>
        )}
      </div>
    </div>
  );
}

function ToolsForConnection({
  connectionId,
  selectedTools,
}: {
  connectionId: string;
  selectedTools: string[] | null;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const { data } = useMCPToolsList({ client });

  const tools = selectedTools
    ? data.tools.filter((t) => selectedTools.includes(t.name))
    : data.tools;

  return (
    <>
      {tools.map((tool) => (
        <CapabilityRow
          key={`${connectionId}-${tool.name}`}
          item={{
            name: tool.name,
            description: tool.description,
            connectionId,
            tags: (
              <ToolAnnotationBadges
                annotations={tool.annotations}
                _meta={tool._meta as Record<string, unknown> | undefined}
              />
            ),
          }}
        />
      ))}
    </>
  );
}

function ResourcesForConnection({
  connectionId,
  selectedResources,
}: {
  connectionId: string;
  selectedResources: string[] | null;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const { data } = useMCPResourcesList({ client });

  const resources = selectedResources
    ? data.resources.filter((r) => selectedResources.includes(r.name || r.uri))
    : data.resources;

  return (
    <>
      {resources.map((resource) => (
        <CapabilityRow
          key={`${connectionId}-${resource.name || resource.uri}`}
          item={{
            name: resource.name || resource.uri,
            description: resource.description,
            connectionId,
          }}
        />
      ))}
    </>
  );
}

function PromptsForConnection({
  connectionId,
  selectedPrompts,
}: {
  connectionId: string;
  selectedPrompts: string[] | null;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const { data } = useMCPPromptsList({ client });

  const prompts = selectedPrompts
    ? data.prompts.filter((p) => selectedPrompts.includes(p.name))
    : data.prompts;

  return (
    <>
      {prompts.map((prompt) => (
        <CapabilityRow
          key={`${connectionId}-${prompt.name}`}
          item={{
            name: prompt.name,
            description: prompt.description,
            connectionId,
          }}
        />
      ))}
    </>
  );
}

function CapabilitiesContent({
  connections,
}: {
  connections: VirtualMCPConnection[];
}) {
  const [filter, setFilter] = useState<CapabilityFilter>("tools");

  return (
    <div className="flex flex-col h-full">
      {/* Filter pills — replaces nested tabs */}
      <div className="flex items-center gap-1 px-6 py-3 border-b border-border shrink-0">
        {FILTER_OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer",
              filter === value
                ? "bg-foreground/8 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Items list */}
      <div className="flex-1 overflow-auto">
        <div className="flex flex-col px-3 py-2 pb-8">
          {filter === "tools" &&
            connections.map((conn) => (
              <ErrorBoundary key={conn.connection_id} fallback={() => null}>
                <Suspense fallback={null}>
                  <ToolsForConnection
                    connectionId={conn.connection_id}
                    selectedTools={conn.selected_tools}
                  />
                </Suspense>
              </ErrorBoundary>
            ))}

          {filter === "resources" &&
            connections.map((conn) => (
              <ErrorBoundary key={conn.connection_id} fallback={() => null}>
                <Suspense fallback={null}>
                  <ResourcesForConnection
                    connectionId={conn.connection_id}
                    selectedResources={conn.selected_resources}
                  />
                </Suspense>
              </ErrorBoundary>
            ))}

          {filter === "prompts" &&
            connections.map((conn) => (
              <ErrorBoundary key={conn.connection_id} fallback={() => null}>
                <Suspense fallback={null}>
                  <PromptsForConnection
                    connectionId={conn.connection_id}
                    selectedPrompts={conn.selected_prompts}
                  />
                </Suspense>
              </ErrorBoundary>
            ))}
        </div>
      </div>
    </div>
  );
}

export function AgentCapabilities({ connections }: AgentCapabilitiesProps) {
  if (connections.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        No connections added yet.
      </div>
    );
  }

  return <CapabilitiesContent connections={connections} />;
}
