import {
  ORG_ADMIN_PROJECT_SLUG,
  useVirtualMCPActions,
  useVirtualMCPs,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Users03, ChevronRight, Plus, Loading01 } from "@untitledui/icons";
import { Link, useNavigate } from "@tanstack/react-router";
import { IntegrationIcon } from "@/web/components/integration-icon";

interface ConnectionVirtualMCPsSectionProps {
  connectionId: string;
  connectionTitle: string;
  connectionDescription?: string | null;
  connectionIcon?: string | null;
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
      params={{ org, project: ORG_ADMIN_PROJECT_SLUG, agentId: virtualMcp.id }}
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

function CreateVirtualMCPButton({
  connectionId,
  connectionTitle,
  connectionDescription,
  connectionIcon,
  org,
  hasExistingVirtualMcps,
}: {
  connectionId: string;
  connectionTitle: string;
  connectionDescription?: string | null;
  connectionIcon?: string | null;
  org: string;
  hasExistingVirtualMcps: boolean;
}) {
  const navigate = useNavigate();
  const actions = useVirtualMCPActions();

  const handleCreateVirtualMCP = async () => {
    const result = await actions.create.mutateAsync({
      title: `${connectionTitle} Agent`,
      description: connectionDescription ?? null,
      icon: connectionIcon ?? null,
      status: "active",
      connections: [
        {
          connection_id: connectionId,
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    navigate({
      to: "/$org/$project/agents/$agentId/",
      params: { org, project: ORG_ADMIN_PROJECT_SLUG, agentId: result.id },
    });
  };

  if (hasExistingVirtualMcps) {
    return (
      <Button
        variant="ghost"
        className="size-6 p-0"
        onClick={handleCreateVirtualMCP}
        disabled={actions.create.isPending}
      >
        {actions.create.isPending ? (
          <Loading01 size={16} className="animate-spin" />
        ) : (
          <Plus size={16} />
        )}
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCreateVirtualMCP}
      disabled={actions.create.isPending}
    >
      {actions.create.isPending ? (
        <Loading01 className="animate-spin text-muted-foreground" />
      ) : (
        <Users03 className="size-3 text-muted-foreground" />
      )}
      Create an agent
    </Button>
  );
}

export function ConnectionVirtualMCPsSection({
  connectionId,
  connectionTitle,
  connectionDescription,
  connectionIcon,
  org,
}: ConnectionVirtualMCPsSectionProps) {
  // Fetch virtual MCPs filtered by this connection
  const virtualMcps = useVirtualMCPs({
    filters: [{ column: "connection_id", value: connectionId }],
  });

  const hasVirtualMcps = virtualMcps.length > 0;

  if (!hasVirtualMcps) {
    // No virtual MCPs - show the "Use in your IDE" section
    return (
      <div className="p-5 flex items-center justify-between gap-3">
        <h4 className="text-xs text-muted-foreground font-medium">
          Use in your IDE
        </h4>
        <CreateVirtualMCPButton
          connectionId={connectionId}
          connectionTitle={connectionTitle}
          connectionDescription={connectionDescription}
          connectionIcon={connectionIcon}
          org={org}
          hasExistingVirtualMcps={false}
        />
      </div>
    );
  }

  // Has virtual MCPs - show the list
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs text-muted-foreground font-medium">
          Use in your IDE
        </h4>
        <CreateVirtualMCPButton
          connectionId={connectionId}
          connectionTitle={connectionTitle}
          connectionDescription={connectionDescription}
          connectionIcon={connectionIcon}
          org={org}
          hasExistingVirtualMcps={true}
        />
      </div>
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
