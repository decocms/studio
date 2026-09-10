import { useProjectContext, useVirtualMCPs } from "@/sdk";
import type { ConnectionEntity } from "@/sdk";
import { ConnectionVirtualMCPsSection } from "./settings-tab/connection-virtual-mcps-section";
import { useT } from "@/i18n/use-t.ts";

interface ConnectionAgentsPanelProps {
  connection: ConnectionEntity;
}

export function ConnectionAgentsPanel({
  connection,
}: ConnectionAgentsPanelProps) {
  const t = useT();
  const { org } = useProjectContext();

  const virtualMcps = useVirtualMCPs({
    filters: [{ column: "connection_id", value: connection.id }],
  });

  const hasVirtualMcps = virtualMcps.length > 0;

  if (!hasVirtualMcps) {
    return <></>;
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">
          {t("details.connectionAgentsPanel.usedByAgents")}
        </h3>
      </div>
      <div className="px-5 py-4">
        <ConnectionVirtualMCPsSection
          virtualMcps={virtualMcps}
          org={org.slug}
        />
      </div>
    </div>
  );
}
