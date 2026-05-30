/**
 * Plugin Layout
 *
 * Generic layout for plugins that filters connections by binding
 * and provides PluginContext to plugin routes.
 *
 * Connection selection is controlled by project settings (plugin bindings).
 * If no connection is configured for the plugin, an empty state is shown
 * prompting the user to configure it in project settings.
 */

import {
  Binder,
  PluginConnectionEntity,
  PluginContext,
  PluginContextPartial,
  PluginSession,
} from "@decocms/bindings";
import type { PluginRenderHeaderProps } from "@decocms/bindings/plugins";
import { PluginContextProvider } from "@decocms/mesh-sdk/plugins";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import {
  Outlet,
  useParams,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Loading01, Settings02 } from "@untitledui/icons";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { Page } from "@/web/components/page";

interface PluginLayoutProps {
  /**
   * Server-side binding name to filter connections (e.g., "WORKFLOW").
   */
  bindingName: string;

  /**
   * Render the header with connection selector.
   * Receives the list of valid connections and current selection handlers.
   */
  renderHeader: (props: PluginRenderHeaderProps) => ReactNode;

  /**
   * Render the empty state when no valid connections are available.
   */
  renderEmptyState: () => ReactNode;
}

/**
 * Converts a ConnectionEntity to PluginConnectionEntity.
 */
function toPluginConnectionEntity(
  conn: ConnectionEntity,
): PluginConnectionEntity {
  return {
    id: conn.id,
    title: conn.title,
    icon: conn.icon,
    description: conn.description,
    app_name: conn.app_name,
    app_id: conn.app_id,
    tools: conn.tools,
    metadata: conn.metadata,
  };
}

/**
 * Plugin layout component that filters connections by binding
 * and provides PluginContext to children.
 *
 * Always provides context (for session/org access) even when no
 * valid connections are available. Connection-related fields are
 * null in that case.
 */
type PluginConfigOutput = {
  config: {
    id: string;
    projectId: string;
    pluginId: string;
    connectionId: string | null;
    settings: Record<string, unknown> | null;
  } | null;
};

export function PluginLayout({
  bindingName,
  renderEmptyState,
}: PluginLayoutProps) {
  const { org, project } = useProjectContext();
  const navigate = useNavigate();
  const {
    org: orgParam,
    taskId,
    pluginId,
  } = useParams({
    strict: false,
  }) as { org: string; taskId: string; pluginId: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const virtualMcpId = search.virtualmcpid;
  // Server-side binding filter — no need to load all connections
  const validConnections = useConnections({ binding: bindingName });
  const { data: authSession } = authClient.useSession();

  // Fetch project's plugin config to get configured connection
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data: pluginConfig, isLoading: isLoadingConfig } = useQuery({
    queryKey: KEYS.projectPluginConfig(project.id ?? "", pluginId),
    queryFn: async () => {
      const result = (await selfClient.callTool({
        name: "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
        arguments: {
          virtualMcpId: project.id,
          pluginId,
        },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as PluginConfigOutput;
    },
    enabled: !!project.id && !!pluginId,
  });

  // Connection is determined solely by project config
  const configuredConnectionId = pluginConfig?.config?.connectionId;
  const configuredConnection = configuredConnectionId
    ? validConnections.find((c) => c.id === configuredConnectionId)
    : null;

  // Call hook unconditionally - pass undefined to skip when no valid configured connection
  // This must be called before any early returns to satisfy React's Rules of Hooks
  const configuredClient = useMCPClientOptional({
    connectionId: configuredConnection?.id,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Build session for context (always available)
  const session: PluginSession | null = authSession?.user
    ? {
        user: {
          id: authSession.user.id,
          name: authSession.user.name,
          email: authSession.user.email,
          image: authSession.user.image,
        },
      }
    : null;

  // Build org context (always available)
  const orgContext = {
    id: org.id,
    slug: org.slug,
    name: org.name,
  };

  // Show loading state while fetching config
  if (isLoadingConfig) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loading01
          size={32}
          className="animate-spin text-muted-foreground mb-4"
        />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // If no valid connections exist at all, show the plugin's empty state
  if (validConnections.length === 0) {
    const emptyContext: PluginContextPartial<Binder> = {
      connectionId: null,
      connection: null,
      toolCaller: null,
      org: orgContext,
      session,
    };

    return (
      <PluginContextProvider value={emptyContext}>
        <div className="h-full flex flex-col overflow-hidden">
          {renderEmptyState()}
        </div>
      </PluginContextProvider>
    );
  }

  // If no connection is configured in project settings, prompt user to configure
  if (!configuredConnection) {
    const emptyContext: PluginContextPartial<Binder> = {
      connectionId: null,
      connection: null,
      toolCaller: null,
      org: orgContext,
      session,
    };

    return (
      <PluginContextProvider value={emptyContext}>
        <div className="h-full flex flex-col items-center justify-center gap-4 p-8">
          <div className="flex flex-col items-center gap-2 text-center max-w-md">
            <Settings02 size={48} className="text-muted-foreground mb-2" />
            <h2 className="text-lg font-semibold">Plugin Not Configured</h2>
            <p className="text-sm text-muted-foreground">
              This plugin requires a connection to be configured. Go to project
              settings to select which integration to use.
            </p>
          </div>
          <Button
            onClick={() => {
              const targetOrg = orgParam ?? org.slug;
              const targetVirtualMcp = virtualMcpId ?? project.id ?? "";
              const targetTaskId = taskId ?? crypto.randomUUID();
              navigate({
                to: "/$org/$taskId",
                params: { org: targetOrg, taskId: targetTaskId },
                search: {
                  virtualmcpid: targetVirtualMcp,
                  main: "settings",
                },
              });
            }}
          >
            Go to Project Settings
          </Button>
        </div>
      </PluginContextProvider>
    );
  }

  // Create the plugin context with connection
  // TypedToolCaller is generic - the plugin will cast it to the correct binding type
  const pluginContext: PluginContext<Binder> = {
    connectionId: configuredConnection.id,
    connection: toPluginConnectionEntity(configuredConnection),
    // The toolCaller accepts any tool name and args at runtime
    // Type safety is enforced by the plugin using usePluginContext<MyBinding>()
    toolCaller: ((toolName: string, args: unknown) =>
      configuredClient
        ? configuredClient
            .callTool({
              name: toolName,
              arguments: args as Record<string, unknown>,
            })
            .then((result) => result.structuredContent ?? result)
        : Promise.reject(
            new Error("MCP client is not available"),
          )) as PluginContext<Binder>["toolCaller"],
    org: orgContext,
    session,
  };

  return (
    <PluginContextProvider value={pluginContext}>
      <Page>
        <Page.Content>
          <Outlet />
        </Page.Content>
      </Page>
    </PluginContextProvider>
  );
}
