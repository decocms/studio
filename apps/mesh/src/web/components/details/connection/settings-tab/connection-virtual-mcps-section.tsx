import { type VirtualMCPEntity } from "@decocms/mesh-sdk";
import { Users03, ChevronRight } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";
import { IntegrationIcon } from "@/web/components/integration-icon";

interface ConnectionVirtualMCPsSectionProps {
  virtualMcps: VirtualMCPEntity[];
  org: string;
}

function VirtualMCPListItem({
  virtualMcp,
  org,
}: {
  virtualMcp: VirtualMCPEntity;
  org: string;
}) {
  return (
    <Link
      to="/$org/$project/agents/$agentId/"
      params={{ org, project: "org-admin", agentId: virtualMcp.id }}
      className="flex items-center gap-3 rounded-lg hover:bg-muted/50 transition-colors group"
    >
      <IntegrationIcon
        icon={virtualMcp.icon}
        name={virtualMcp.title}
        size="xs"
        fallbackIcon={<Users03 size={16} />}
      />
      <span className="flex-1 text-sm font-medium text-foreground truncate">
        {virtualMcp.title}
      </span>
      <ChevronRight
        size={16}
        className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0"
      />
    </Link>
  );
}

export function ConnectionVirtualMCPsSection({
  virtualMcps,
  org,
}: ConnectionVirtualMCPsSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {virtualMcps.map((virtualMcp) => (
          <VirtualMCPListItem
            key={virtualMcp.id}
            virtualMcp={virtualMcp}
            org={org}
          />
        ))}
      </div>
    </div>
  );
}
