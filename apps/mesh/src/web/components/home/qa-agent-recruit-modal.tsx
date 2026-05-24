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
import { QA_AGENT_SYSTEM_PROMPT } from "./qa-agent-system-prompt";

const QA_MCP_APP_ID = "deco/qa-mcp";
const QA_MCP_URL = "https://qa-mcp.deco-cx.workers.dev/api/mcp";
const QA_MCP_APP_NAME = "qa-mcp";

interface QaAgentRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAgent?: { id: string } | null;
}

const CAPABILITIES = [
  "Drives a real browser (Playwright) via primitive tools",
  "Goal-driven planning with self-loop detection",
  "Validates e-commerce flows: PLP → PDP → cart → checkout",
  "Honest verdicts: objective_met, blocked, or exhausted",
  "Respects a per-run budget (50 primitive calls)",
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
        Add an autonomous QA agent that drives a real browser to test your
        site's critical user flows end-to-end.
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
        {isRecruiting ? "Setting up..." : "Add QA Agent"}
      </Button>
    </div>
  );
}

export function QaAgentRecruitModal({
  open,
  onOpenChange,
  existingAgent,
}: QaAgentRecruitModalProps) {
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

  const template = WELL_KNOWN_AGENT_TEMPLATES.find((t) => t.id === "qa-agent")!;

  const headerIcon = (
    <IntegrationIcon icon={template.icon} name={template.title} size="sm" />
  );

  const handleRecruit = async () => {
    if (existingAgent) {
      onOpenChange(false);
      navigateToAgent(existingAgent.id);
      return;
    }

    setIsRecruiting(true);
    try {
      const existingConnectionResult = await connectionQuery.mutateAsync({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          where: {
            field: ["app_id"],
            operator: "eq",
            value: QA_MCP_APP_ID,
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
        (c) => c.app_id === QA_MCP_APP_ID,
      );

      if (matchingConnection) {
        connectionId = matchingConnection.id;
      } else {
        const connection = await connectionActions.create.mutateAsync({
          title: "QA mcp",
          description: "Autonomous QA agent driven by Playwright.",
          icon: template.icon,
          connection_type: "HTTP",
          connection_url: QA_MCP_URL,
          app_name: QA_MCP_APP_NAME,
          app_id: QA_MCP_APP_ID,
          metadata: {
            type: "qa-agent",
            source: "store",
            registry_item_id: QA_MCP_APP_ID,
            verified: false,
          },
        });
        connectionId = connection.id;
      }

      const virtualMcp = await virtualMcpActions.create.mutateAsync({
        title: template.title,
        description:
          "Drive a real browser to test critical user flows end-to-end.",
        icon: template.icon,
        status: "active",
        connections: [
          {
            connection_id: connectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        metadata: {
          type: "qa-agent",
          instructions: QA_AGENT_SYSTEM_PROMPT,
        },
      });

      track("agent_recruit_confirmed", {
        template_id: "qa-agent",
        agent_id: virtualMcp.id!,
      });
      onOpenChange(false);
      navigateToAgent(virtualMcp.id!);
    } catch (error) {
      track("agent_recruit_failed", {
        template_id: "qa-agent",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Failed to create QA Agent:", error);
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
