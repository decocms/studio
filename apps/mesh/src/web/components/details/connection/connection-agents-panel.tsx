import { useProjectContext, useVirtualMCPs } from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { ConnectionVirtualMCPsSection } from "./settings-tab/connection-virtual-mcps-section";

interface ConnectionAgentsPanelProps {
  connection: ConnectionEntity;
}

export function ConnectionAgentsPanel({
  connection,
}: ConnectionAgentsPanelProps) {
  const { org } = useProjectContext();
  const virtualMcps = useVirtualMCPs({
    filters: [{ column: "connection_id", value: connection.id }],
  });

  if (virtualMcps.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">
          Used by agents
        </h3>
      </div>
      <div className="px-2 py-2">
        <ConnectionVirtualMCPsSection
          connectionId={connection.id}
          connectionTitle={connection.title}
          connectionDescription={connection.description}
          connectionIcon={connection.icon}
          org={org.slug}
        />
      </div>
    </div>
  );
}
