/**
 * Site Diagnostics Recruitment Modal
 *
 * Shown when the user clicks the Site Diagnostics agent on the home page.
 * Creates a real HTTP connection + virtual MCP via the existing APIs,
 * then navigates to the agent view.
 *
 * All MCP metadata (title, description, icon, URL) is fetched from the
 * deco registry at runtime — no hardcoded constants.
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
  useConnectionActions,
  useMCPClient,
  useMCPToolCallMutation,
  useProjectContext,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { useRegistryApp } from "@/web/hooks/use-registry-app";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { track } from "@/web/lib/posthog-client";

interface SiteDiagnosticsRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAgent?: { id: string } | null;
}

const CAPABILITIES = [
  "Full HAR capture with cache, TTFB, and request analysis",
  "Screenshot capture for visual inspection",
  "Page discovery via sitemap, navigation, and link crawling",
  "SEO audit — meta tags, structured data, robots.txt",
  "Third-party script inventory and size analysis",
  "Dead link detection across the entire site",
  "Deco-specific diagnostics (?__d debug mode)",
];

function RecruitContent({
  onRecruit,
  isRecruiting,
  isLoading,
}: {
  onRecruit: () => void;
  isRecruiting: boolean;
  isLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Add a blackbox diagnostics agent that tests your storefront from the
        outside — no internal access needed. Give it a URL and it produces a
        detailed performance and health report.
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
        disabled={isRecruiting || isLoading}
        className="w-full cursor-pointer"
      >
        {isRecruiting ? "Setting up..." : "Add Site Diagnostics"}
      </Button>
    </div>
  );
}

export function SiteDiagnosticsRecruitModal({
  open,
  onOpenChange,
  existingAgent,
}: SiteDiagnosticsRecruitModalProps) {
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
    (t) => t.id === "site-diagnostics",
  )!;

  // Only fetch from registry when the modal is open (CTA time)
  const { data: registryItem, isLoading: isRegistryLoading } = useRegistryApp(
    template.appId,
    { enabled: open },
  );

  const appTitle =
    registryItem?.title ||
    registryItem?.server?.title ||
    registryItem?.server?.name ||
    template.title;
  const appIcon = registryItem?.server?.icons?.[0]?.src ?? template.icon;
  const appDescription = registryItem?.server?.description ?? null;

  const headerIcon = (
    <IntegrationIcon icon={appIcon} name={appTitle} size="sm" />
  );

  const handleRecruit = async () => {
    if (!registryItem) return;

    // If agent already exists, just navigate to it
    if (existingAgent) {
      onOpenChange(false);
      navigateToAgent(existingAgent.id);
      return;
    }

    setIsRecruiting(true);
    try {
      // 1. Find or create the HTTP connection to the external site-diagnostics MCP
      const existingConnectionResult = await connectionQuery.mutateAsync({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          where: {
            field: ["app_id"],
            operator: "eq",
            value: template.appId,
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
        (c) => c.app_id === template.appId,
      );

      if (matchingConnection) {
        connectionId = matchingConnection.id;
      } else {
        const remoteUrl = registryItem.server?.remotes?.[0]?.url;
        if (!remoteUrl) {
          throw new Error(
            "Registry item is missing a remote URL for site-diagnostics",
          );
        }
        const connection = await connectionActions.create.mutateAsync({
          title: appTitle,
          description: appDescription,
          icon: registryItem.server?.icons?.[0]?.src ?? template.icon,
          connection_type: "HTTP",
          connection_url: remoteUrl,
          app_name: registryItem.server?.name ?? "site-diagnostics",
          app_id: template.appId,
          metadata: {
            type: "site-diagnostics",
            source: "store",
            registry_item_id: template.appId,
            verified: true,
          },
        });
        connectionId = connection.id;
      }

      // 3. Create a virtual MCP (agent) with the connection attached
      const virtualMcp = await virtualMcpActions.create.mutateAsync({
        title: appTitle,
        description: appDescription,
        icon: appIcon,
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
          type: "site-diagnostics",
          instructions: null,
          ui: {
            pinnedViews: [
              {
                connectionId,
                toolName: "diagnose",
                label: "diagnose",
                icon: null,
              },
            ],
            layout: {
              defaultMainView: {
                type: "ext-apps",
                id: connectionId,
                toolName: "diagnose",
              },
            },
          },
        },
      });

      // 4. Navigate to the new agent
      track("agent_recruit_confirmed", {
        template_id: "site-diagnostics",
        agent_id: virtualMcp.id!,
      });
      onOpenChange(false);
      navigateToAgent(virtualMcp.id!);
    } catch (error) {
      track("agent_recruit_failed", {
        template_id: "site-diagnostics",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Failed to create Site Diagnostics agent:", error);
    } finally {
      setIsRecruiting(false);
    }
  };

  const title = `Add ${appTitle}`;

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
            isLoading={isRegistryLoading}
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
        <RecruitContent
          onRecruit={handleRecruit}
          isRecruiting={isRecruiting}
          isLoading={isRegistryLoading}
        />
      </DialogContent>
    </Dialog>
  );
}
