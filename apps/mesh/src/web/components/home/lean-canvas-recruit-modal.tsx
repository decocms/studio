/**
 * Lean Canvas Recruitment Modal
 *
 * Shown when the user clicks the Lean Canvas template on the home page.
 * Creates an HTTP connection to the external Lean Canvas MCP + virtual MCP,
 * then navigates to the agent view.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  SELF_MCP_ALIAS_ID,
  WELL_KNOWN_AGENT_TEMPLATES,
  WellKnownOrgMCPId,
  useConnectionActions,
  useMCPClient,
  useMCPToolCallMutation,
  useProjectContext,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { track } from "@/web/lib/posthog-client";

const LEAN_CANVAS_MCP_URL = "https://sites-lean-canva.decocache.com/api/mcp";

interface LeanCanvasRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAgent?: { id: string } | null;
}

const CAPABILITIES = [
  "Build and update Lean Canvas business models visually",
  "Interactive grid UI with all 9 canvas sections",
  "Iterative updates — add information as you discover it",
  "Covers: Problem, Solution, Key Metrics, Unique Value Proposition",
  "Covers: Channels, Customer Segments, Cost Structure, Revenue Streams",
  "Unfair Advantage analysis",
];

function RecruitContent({
  onRecruit,
  isRecruiting,
}: {
  onRecruit: () => void;
  isRecruiting: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Add a Lean Canvas agent that helps you build and iterate on your
        business model. Describe your idea and it produces a visual, structured
        canvas.
      </p>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Capabilities</p>
        <ul className="space-y-1.5">
          {CAPABILITIES.map((cap) => (
            <li
              key={cap}
              className="text-sm text-muted-foreground flex items-start gap-2"
            >
              <span className="text-emerald-500 mt-0.5 shrink-0">+</span>
              {cap}
            </li>
          ))}
        </ul>
      </div>

      <Button
        onClick={onRecruit}
        disabled={isRecruiting}
        className="w-full cursor-pointer"
      >
        {isRecruiting ? "Setting up..." : "Add Lean Canvas"}
      </Button>
    </div>
  );
}

export function LeanCanvasRecruitModal({
  open,
  onOpenChange,
  existingAgent,
}: LeanCanvasRecruitModalProps) {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();
  const navigateToAgent = useNavigateToAgent();
  const connectionActions = useConnectionActions();
  const virtualMcpActions = useVirtualMCPActions();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const connectionQuery = useMCPToolCallMutation({ client });
  const [isRecruiting, setIsRecruiting] = useState(false);

  const template = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "lean-canvas",
  )!;

  const headerIcon = (
    <IntegrationIcon icon={template.icon} name={template.title} size="sm" />
  );

  const handleRecruit = async () => {
    // If agent already exists, just navigate to it
    if (existingAgent) {
      onOpenChange(false);
      navigateToAgent(existingAgent.id);
      return;
    }

    setIsRecruiting(true);
    try {
      // 1. Find or create the HTTP connection to the external Lean Canvas MCP
      const existingConnectionResult = await connectionQuery.mutateAsync({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          where: {
            field: ["app_id"],
            operator: "eq",
            value: "lean-canvas",
          },
          limit: 1,
          offset: 0,
        },
      });

      let connectionId: string;
      const existingConnections = (
        existingConnectionResult as {
          structuredContent?: CollectionListOutput<ConnectionEntity>;
        }
      )?.structuredContent?.items;

      const matchingConnection = existingConnections?.find(
        (c) => c.app_id === "lean-canvas",
      );

      const selfConnectionId = WellKnownOrgMCPId.SELF(org.id);

      if (matchingConnection) {
        connectionId = matchingConnection.id;
      } else {
        const connection = await connectionActions.create.mutateAsync({
          title: template.title,
          description: "Lean Canvas business model builder",
          icon: template.icon,
          connection_type: "HTTP",
          connection_url: LEAN_CANVAS_MCP_URL,
          app_name: "lean-canvas",
          app_id: "lean-canvas",
          configuration_state: {
            OBJECT_STORAGE: {
              __type: "@deco/object-storage",
              value: selfConnectionId,
            },
          },
          metadata: {
            type: "lean-canvas",
            source: "store",
            verified: true,
          },
        });
        connectionId = connection.id;
      }

      // 2. Create a virtual MCP (agent) with the connection + self MCP attached
      const virtualMcp = await virtualMcpActions.create.mutateAsync({
        title: template.title,
        description: "Lean Canvas business model builder",
        icon: template.icon,
        status: "active",
        connections: [
          {
            connection_id: connectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
          {
            connection_id: selfConnectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        metadata: {
          type: "lean-canvas",
          instructions: null,
          ui: {
            pinnedViews: [
              {
                connectionId,
                toolName: "lean_canvas",
                label: "lean_canvas",
                icon: null,
              },
            ],
            layout: {
              defaultMainView: {
                type: "ext-apps",
                id: connectionId,
                toolName: "lean_canvas",
              },
            },
          },
        },
      });

      // 3. Navigate to the new agent
      track("agent_recruit_confirmed", {
        template_id: "lean-canvas",
        agent_id: virtualMcp.id!,
      });
      onOpenChange(false);
      navigateToAgent(virtualMcp.id!);
    } catch (error) {
      track("agent_recruit_failed", {
        template_id: "lean-canvas",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Failed to create Lean Canvas agent:", error);
    } finally {
      setIsRecruiting(false);
    }
  };

  const title = `Add ${template.title}`;

  return isMobile ? (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-[70dvh]">
        <DrawerHeader className="px-4 pt-4 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            {headerIcon}
            <DrawerTitle className="text-xl font-semibold">{title}</DrawerTitle>
          </div>
        </DrawerHeader>
        <div className="flex flex-col flex-1 min-h-0 px-4 pb-8">
          <RecruitContent
            onRecruit={handleRecruit}
            isRecruiting={isRecruiting}
          />
        </div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-8">
        <DialogHeader className="mb-4">
          <div className="flex items-center gap-3">
            {headerIcon}
            <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
          </div>
        </DialogHeader>
        <RecruitContent onRecruit={handleRecruit} isRecruiting={isRecruiting} />
      </DialogContent>
    </Dialog>
  );
}
