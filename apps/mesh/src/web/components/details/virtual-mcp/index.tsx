import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { useChatStable } from "@/web/components/chat/context";
import { chatStore } from "@/web/components/chat/store/chat-store";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { IconPicker } from "@/web/components/icon-picker.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { useMCPAuthStatus } from "@/web/hooks/use-mcp-auth-status";
import { authenticateMcp } from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getDecopilotId,
  SELF_MCP_ALIAS_ID,
  useConnection,
  useConnectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Play,
  Plus,
  Settings01,
  Stars01,
  XClose,
  ZapCircle,
} from "@untitledui/icons";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Suspense, useEffect, useReducer, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { ViewActions, ViewLayout } from "../layout";
import { SaveActions } from "@/web/components/save-actions";
import { AddConnectionDialog } from "./add-connection-dialog";
import { AgentCapabilities } from "./agent-capabilities";
import { DependencySelectionDialog } from "./dependency-selection-dialog";
import { ALL_ITEMS_SELECTED, getSelectionSummary } from "./selection-utils";
import { VirtualMcpFormSchema, type VirtualMcpFormData } from "./types";
import { VirtualMCPShareModal } from "./virtual-mcp-share-modal";

export type VirtualMcpVariant = "agent" | "project";

type DialogState = {
  shareDialogOpen: boolean;
  addDialogOpen: boolean;
  settingsDialogOpen: boolean;
  settingsConnectionId: string | null;
};

type DialogAction =
  | { type: "SET_SHARE_DIALOG_OPEN"; payload: boolean }
  | { type: "SET_ADD_DIALOG_OPEN"; payload: boolean }
  | { type: "OPEN_SETTINGS"; payload: string }
  | { type: "CLOSE_SETTINGS" };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "SET_SHARE_DIALOG_OPEN":
      return { ...state, shareDialogOpen: action.payload };
    case "SET_ADD_DIALOG_OPEN":
      return { ...state, addDialogOpen: action.payload };
    case "OPEN_SETTINGS":
      return {
        ...state,
        settingsDialogOpen: true,
        settingsConnectionId: action.payload,
      };
    case "CLOSE_SETTINGS":
      return {
        ...state,
        settingsDialogOpen: false,
        settingsConnectionId: null,
      };
    default:
      return state;
  }
}

/**
 * Connection Item - Card layout inspired by the reference design:
 * Body: icon + name + description (clickable → connection detail page)
 * Footer: instance selector + resources summary + edit (resource config) + remove
 */
function ConnectionItem({
  connection_id,
  selected_tools,
  selected_resources,
  selected_prompts,
  onOpenSettings,
  onRemove,
  onAuthenticate,
  onSwitchInstance,
}: {
  connection_id: string;
  selected_tools: string[] | null;
  selected_resources: string[] | null;
  selected_prompts: string[] | null;
  onOpenSettings: () => void;
  onRemove: () => void;
  onAuthenticate: (connectionId: string) => void;
  onSwitchInstance: (oldId: string, newId: string) => void;
}) {
  const connection = useConnection(connection_id);
  const { org } = useProjectContext();
  const allConnections = useConnections();

  if (!connection) return null;

  const slug = getConnectionSlug(connection);

  // Find sibling instances (same slug, non-virtual)
  const siblings = allConnections.filter(
    (c) => c.connection_type !== "VIRTUAL" && getConnectionSlug(c) === slug,
  );
  const hasMultipleInstances = siblings.length > 1;

  return (
    <Suspense
      fallback={<ConnectionItemAuthFallback connection_id={connection_id} />}
    >
      <ConnectionItemWithAuth
        connection_id={connection_id}
        connectionTitle={connection.title}
        connectionDescription={connection.description}
        connectionIcon={connection.icon}
        connectionType={connection.connection_type}
        slug={slug}
        orgSlug={org.slug}
        siblings={hasMultipleInstances ? siblings : []}
        selected_tools={selected_tools}
        selected_resources={selected_resources}
        selected_prompts={selected_prompts}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
        onAuthenticate={onAuthenticate}
        onSwitchInstance={onSwitchInstance}
      />
    </Suspense>
  );
}

function ConnectionItemWithAuth({
  connection_id,
  connectionTitle,
  connectionDescription,
  connectionIcon,
  connectionType,
  slug,
  orgSlug,
  siblings,
  selected_tools,
  selected_resources,
  selected_prompts,
  onOpenSettings,
  onRemove,
  onAuthenticate,
  onSwitchInstance,
}: {
  connection_id: string;
  connectionTitle: string;
  connectionDescription?: string | null;
  connectionIcon?: string | null;
  connectionType: string;
  slug: string;
  orgSlug: string;
  siblings: Array<{ id: string; title: string }>;
  selected_tools: string[] | null;
  selected_resources: string[] | null;
  selected_prompts: string[] | null;
  onOpenSettings: () => void;
  onRemove: () => void;
  onAuthenticate: (connectionId: string) => void;
  onSwitchInstance: (oldId: string, newId: string) => void;
}) {
  const authStatus = useMCPAuthStatus({ connectionId: connection_id });
  const isVirtual = connectionType === "VIRTUAL";
  const needsAuth =
    !isVirtual && authStatus.supportsOAuth && !authStatus.isAuthenticated;

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden transition-colors",
        needsAuth ? "border-destructive/50 bg-destructive/5" : "border-border",
      )}
    >
      {/* Body — clickable, navigates to connection detail */}
      <Link
        to="/$org/mcps/$appSlug"
        params={{
          org: orgSlug,
          appSlug: slug,
        }}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
      >
        <IntegrationIcon
          icon={connectionIcon}
          name={connectionTitle}
          size="sm"
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{connectionTitle}</p>
          {needsAuth ? (
            <span className="text-xs text-destructive font-medium">
              Needs authorization
            </span>
          ) : (
            connectionDescription && (
              <p className="text-xs text-muted-foreground truncate">
                {connectionDescription}
              </p>
            )
          )}
        </div>
        {needsAuth ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onAuthenticate(connection_id);
            }}
          >
            Authorize
          </Button>
        ) : (
          <ChevronRight size={16} className="text-muted-foreground shrink-0" />
        )}
      </Link>

      {/* Footer — instance selector + resources summary + edit + remove */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-muted/25">
        {/* Instance selector */}
        {siblings.length > 0 && (
          <Select
            value={connection_id}
            onValueChange={(newId) => onSwitchInstance(connection_id, newId)}
          >
            <SelectTrigger
              size="sm"
              className="w-auto text-xs gap-1 px-2 border border-border bg-background rounded"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {siblings.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  {s.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Resources summary */}
        <span className="text-xs text-muted-foreground">
          {getSelectionSummary({
            connection_id,
            selected_tools,
            selected_resources,
            selected_prompts,
          })}
        </span>

        <div className="flex items-center gap-0.5 ml-auto">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onOpenSettings}
                aria-label="Configure resources"
              >
                <Settings01 size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Configure resources</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={onRemove}
                aria-label="Remove connection"
              >
                <XClose size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Remove</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ConnectionItemAuthFallback({
  connection_id,
}: {
  connection_id: string;
}) {
  const connection = useConnection(connection_id);
  if (!connection) return <ConnectionItemSkeleton />;

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <IntegrationIcon
          icon={connection.icon}
          name={connection.title}
          size="sm"
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{connection.title}</p>
          {connection.description && (
            <p className="text-xs text-muted-foreground truncate">
              {connection.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center px-4 py-2 border-t border-border bg-muted/25">
        <div className="h-5 w-20 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}

function ConnectionItemSkeleton() {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-md bg-muted animate-pulse shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div className="h-4 w-32 rounded bg-muted animate-pulse" />
          <div className="h-3 w-48 rounded bg-muted animate-pulse" />
        </div>
      </div>
      <div className="flex items-center px-4 py-2 border-t border-border bg-muted/25">
        <div className="h-5 w-20 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar tab content (projects only)
// ---------------------------------------------------------------------------

interface UITool {
  name: string;
  description?: string;
}

interface PinnedView {
  connectionId: string;
  toolName: string;
  label: string;
  icon: string | null;
}

interface ConnectionWithTools {
  id: string;
  title: string;
  icon: string | null;
  uiTools: UITool[];
}

function SidebarTabContent({ virtualMcpId }: { virtualMcpId: string }) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  const virtualMcp = useVirtualMCP(virtualMcpId);

  const connectionIds = (virtualMcp?.connections ?? [])
    .map((c) => c.connection_id)
    .sort();

  const { data: connectionsWithTools } = useQuery({
    queryKey: KEYS.projectConnectionDetails(virtualMcpId, connectionIds),
    enabled: connectionIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        connectionIds.map(async (connId) => {
          try {
            const result = await client.callTool({
              name: "COLLECTION_CONNECTIONS_GET",
              arguments: { id: connId },
            });
            const { item } = unwrapToolResult<{
              item: {
                title?: string;
                icon?: string | null;
                tools?: Array<{
                  name: string;
                  description?: string;
                  _meta?: Record<string, unknown>;
                }> | null;
              } | null;
            }>(result);
            const uiTools: UITool[] = (item?.tools ?? [])
              .filter((t) => !!getUIResourceUri(t._meta))
              .map((t) => ({ name: t.name, description: t.description }));
            return {
              id: connId,
              title: item?.title ?? connId,
              icon: item?.icon ?? null,
              uiTools,
            };
          } catch {
            return {
              id: connId,
              title: connId,
              icon: null,
              uiTools: [],
            };
          }
        }),
      );
      // Only include connections that have interactive tools
      return results.filter((c) => c.uiTools.length > 0);
    },
  });

  const connectionsData: ConnectionWithTools[] = connectionsWithTools ?? [];

  // Current pinned views from virtual MCP metadata
  const serverPinned: PinnedView[] =
    (
      virtualMcp?.metadata?.ui as
        | { pinnedViews?: PinnedView[] | null }
        | null
        | undefined
    )?.pinnedViews ?? [];

  const [pinnedViews, setPinnedViews] = useState<PinnedView[]>(serverPinned);
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges =
    JSON.stringify(pinnedViews) !== JSON.stringify(serverPinned);

  const handleTogglePin = (
    connectionId: string,
    toolName: string,
    connectionIcon: string | null,
  ) => {
    const pinned = pinnedViews.some(
      (v) => v.connectionId === connectionId && v.toolName === toolName,
    );
    if (pinned) {
      setPinnedViews((prev) =>
        prev.filter(
          (v) => !(v.connectionId === connectionId && v.toolName === toolName),
        ),
      );
    } else {
      setPinnedViews((prev) => [
        ...prev,
        { connectionId, toolName, label: toolName, icon: connectionIcon },
      ]);
    }
  };

  const handleLabelChange = (
    connectionId: string,
    toolName: string,
    label: string,
  ) => {
    setPinnedViews((prev) =>
      prev.map((v) =>
        v.connectionId === connectionId && v.toolName === toolName
          ? { ...v, label }
          : v,
      ),
    );
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await client.callTool({
        name: "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
        arguments: { virtualMcpId, pinnedViews },
      });
      unwrapToolResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey.includes("collection") &&
          query.queryKey.includes("VIRTUAL_MCP"),
      });
      toast.success("Sidebar updated");
    },
    onError: (error) => {
      toast.error(
        "Failed to update sidebar: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
    onSettled: () => setIsSaving(false),
  });

  const handleSave = () => {
    setIsSaving(true);
    mutation.mutate();
  };

  const handleCancel = () => {
    setPinnedViews(serverPinned);
  };

  if (connectionIds.length === 0) {
    return (
      <div className="px-6 py-4">
        <p className="text-sm text-muted-foreground">
          No connections yet. Add connections in the Connections tab first.
        </p>
      </div>
    );
  }

  if (connectionsWithTools && connectionsData.length === 0) {
    return (
      <div className="px-6 py-4">
        <p className="text-sm text-muted-foreground">
          None of the connected servers have interactive tools available.
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 space-y-6">
      {connectionsData.map((conn) => (
        <div key={conn.id}>
          <div className="flex items-center gap-2 mb-3">
            <IntegrationIcon
              icon={conn.icon}
              name={conn.title}
              size="2xs"
              className="shrink-0"
            />
            <h3 className="text-sm font-medium text-foreground">
              {conn.title}
            </h3>
          </div>
          {conn.uiTools.length > 0 && (
            <div className="flex flex-col">
              {conn.uiTools.map((tool) => {
                const pinned = pinnedViews.some(
                  (v) => v.connectionId === conn.id && v.toolName === tool.name,
                );
                const pinnedView = pinnedViews.find(
                  (v) => v.connectionId === conn.id && v.toolName === tool.name,
                );
                return (
                  <div
                    key={tool.name}
                    className="flex flex-col border-b border-border last:border-0"
                  >
                    <div
                      className="flex items-center justify-between gap-6 py-3 cursor-pointer"
                      onClick={() =>
                        handleTogglePin(conn.id, tool.name, conn.icon)
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">
                          {tool.name}
                        </p>
                        {tool.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {tool.description}
                          </p>
                        )}
                      </div>
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0"
                      >
                        <Switch
                          checked={pinned}
                          onCheckedChange={() =>
                            handleTogglePin(conn.id, tool.name, conn.icon)
                          }
                          disabled={isSaving}
                        />
                      </div>
                    </div>
                    {pinned && pinnedView && (
                      <div
                        className="pb-3 pl-0 flex items-center gap-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <label className="text-xs text-muted-foreground w-12 shrink-0">
                          Label
                        </label>
                        <Input
                          value={pinnedView.label}
                          onChange={(e) =>
                            handleLabelChange(
                              conn.id,
                              tool.name,
                              e.target.value,
                            )
                          }
                          className="h-8 text-sm w-56"
                          disabled={isSaving}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {hasChanges && (
        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Sidebar"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main detail view
// ---------------------------------------------------------------------------

function VirtualMcpDetailViewWithData({
  virtualMcp,
  variant,
}: {
  virtualMcp: VirtualMCPEntity;
  variant: VirtualMcpVariant;
}) {
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();

  const isAgent = variant === "agent";

  // Form setup
  const form = useForm<VirtualMcpFormData>({
    resolver: zodResolver(VirtualMcpFormSchema),
    defaultValues: virtualMcp,
  });

  // Watch connections for reactive UI
  const connections = form.watch("connections");

  // Dialog states
  const [dialogState, dispatch] = useReducer(dialogReducer, {
    shareDialogOpen: false,
    addDialogOpen: false,
    settingsDialogOpen: false,
    settingsConnectionId: null,
  });

  // Tab state
  const [activeTab, setActiveTab] = useState(
    localStorage.getItem("agent-detail-tab") || "instructions",
  );

  const handleImprovePrompt = () => {
    const currentInstructions = form.getValues("metadata.instructions");
    if (!currentInstructions?.trim()) return;

    setChatOpen(true);

    chatStore.createThreadAndSend({
      parts: [
        {
          type: "text",
          text: `/writing-prompts ${virtualMcp.id}\n\n<instructions>\n${currentInstructions}\n</instructions>`,
        },
      ],
      agent: {
        id: getDecopilotId(org.id),
        title: "Decopilot",
        description: null,
        icon: null,
      },
      toolApprovalLevel: "plan",
    });
  };

  // Chat hooks
  const [, setChatOpen] = useDecoChatOpen();
  const { setVirtualMcpId } = useChatStable();

  // Agents: open chat on mount and select this agent
  // Projects: skip (virtual-mcp-layout handles it)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!isAgent) return;
    setChatOpen(true);
    setVirtualMcpId(virtualMcp.id);
    // eslint-disable-next-line react-hooks/exhaustive-depsbun
  }, [virtualMcp.id, isAgent]);

  const handleTestAgent = () => {
    setVirtualMcpId(virtualMcp.id);
    setChatOpen(true);
  };

  const hasFormChanges = form.formState.isDirty;

  const handleSave = async () => {
    const formData = form.getValues();

    const data = await actions.update.mutateAsync({
      id: virtualMcp.id,
      data: formData,
    });

    form.reset(data);
  };

  const handleCancel = () => {
    form.reset(virtualMcp);
  };

  const handleOpenAddDialog = () => {
    dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: true });
  };

  const handleAddConnection = (connectionId: string) => {
    const current = form.getValues("connections");
    // Don't add duplicates
    if (current.some((c) => c.connection_id === connectionId)) return;

    form.setValue(
      "connections",
      [
        ...current,
        {
          connection_id: connectionId,
          selected_tools: ALL_ITEMS_SELECTED.tools,
          selected_resources: ALL_ITEMS_SELECTED.resources,
          selected_prompts: ALL_ITEMS_SELECTED.prompts,
        },
      ],
      { shouldDirty: true },
    );
  };

  const handleRemoveConnection = (connectionId: string) => {
    const current = form.getValues("connections");
    form.setValue(
      "connections",
      current.filter((c) => c.connection_id !== connectionId),
      { shouldDirty: true },
    );
  };

  const handleSwitchInstance = (oldId: string, newId: string) => {
    const current = form.getValues("connections");
    form.setValue(
      "connections",
      current.map((c) =>
        c.connection_id === oldId ? { ...c, connection_id: newId } : c,
      ),
      { shouldDirty: true },
    );
  };

  const handleOpenSettings = (connectionId: string) => {
    dispatch({ type: "OPEN_SETTINGS", payload: connectionId });
  };

  const handleAuthenticate = async (connectionId: string) => {
    const { token, tokenInfo, error } = await authenticateMcp({
      connectionId,
    });
    if (error || !token) {
      toast.error(`Authentication failed: ${error}`);
      return;
    }

    if (tokenInfo) {
      try {
        const response = await fetch(
          `/api/connections/${connectionId}/oauth-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              accessToken: tokenInfo.accessToken,
              refreshToken: tokenInfo.refreshToken,
              expiresIn: tokenInfo.expiresIn,
              scope: tokenInfo.scope,
              clientId: tokenInfo.clientId,
              clientSecret: tokenInfo.clientSecret,
              tokenEndpoint: tokenInfo.tokenEndpoint,
            }),
          },
        );
        if (!response.ok) {
          console.error("Failed to save OAuth token:", await response.text());
          await connectionActions.update.mutateAsync({
            id: connectionId,
            data: { connection_token: token },
          });
        } else {
          try {
            await connectionActions.update.mutateAsync({
              id: connectionId,
              data: {},
            });
          } catch (err) {
            console.warn(
              "Failed to refresh connection tools after OAuth:",
              err,
            );
          }
        }
      } catch (err) {
        console.error("Error saving OAuth token:", err);
        await connectionActions.update.mutateAsync({
          id: connectionId,
          data: { connection_token: token },
        });
      }
    } else {
      await connectionActions.update.mutateAsync({
        id: connectionId,
        data: { connection_token: token },
      });
    }

    const mcpProxyUrl = new URL(`/mcp/${connectionId}`, window.location.origin);
    await queryClient.invalidateQueries({
      queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
    });

    toast.success("Authentication successful");
  };

  const handleInsertTemplate = () => {
    const current = form.getValues("metadata.instructions") ?? "";
    const template = `<role>
Define who this agent is and what it specializes in.
Example: You are a support triage agent for B2B merchants.
</role>

<capabilities>
List what this agent can do using its connected tools.
- Investigate issues using connected data sources.
- Summarize findings and recommend next steps.
</capabilities>

<constraints>
Set clear boundaries on what the agent must not do.
- Do not perform destructive actions without confirmation.
- Escalate to a human when the request is outside your expertise.
</constraints>

<workflows>
Define step-by-step how the agent should handle requests.

## Default workflow
1. Read the user's request and gather context.
2. Use the appropriate tools to investigate or act.
3. Summarize the result and propose next steps.
4. Ask for confirmation before making any changes.
</workflows>`;
    const next = current.trim() ? `${current}\n\n${template}` : template;
    form.setValue("metadata.instructions", next, { shouldDirty: true });
  };

  const isSaving = actions.update.isPending;
  const addedConnectionIds = new Set(connections.map((c) => c.connection_id));

  // Variant-specific breadcrumb
  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to={isAgent ? "/$org/agents" : "/$org/projects"}
              params={{ org: org.slug }}
            >
              {isAgent ? "Agents" : "Projects"}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{virtualMcp.title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  // Variant-specific tabs
  const tabs = [
    {
      id: "instructions",
      label: isAgent ? "Instructions" : "AGENTS.md",
    },
    {
      id: "connections",
      label: "Connections",
      count: connections.length || undefined,
    },
    ...(isAgent ? [{ id: "capabilities", label: "Capabilities" }] : []),
    ...(!isAgent ? [{ id: "sidebar", label: "Sidebar" }] : []),
  ];

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={handleCancel}
          isDirty={hasFormChanges}
          isSaving={isSaving}
        />
        {isAgent && (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <span className="inline-block">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2 border border-input"
                  onClick={handleTestAgent}
                  aria-label="Test Agent"
                >
                  <Play size={14} />
                  Test Agent
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Test this agent in chat
            </TooltipContent>
          </Tooltip>
        )}

        {isAgent && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 border border-input"
            onClick={() =>
              dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: true })
            }
          >
            <ZapCircle size={14} />
            Connect
          </Button>
        )}
      </ViewActions>

      <div className="flex h-full w-full bg-background overflow-auto">
        <div className="flex flex-col w-full">
          {/* Header section */}
          <div className="flex items-start justify-between gap-4 p-6 shrink-0">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <Controller
                control={form.control}
                name="icon"
                render={({ field }) => (
                  <IconPicker
                    value={field.value}
                    onChange={field.onChange}
                    onColorChange={(color) =>
                      form.setValue("metadata.ui.themeColor", color, {
                        shouldDirty: true,
                      })
                    }
                    name={
                      form.watch("title") || (isAgent ? "Agent" : "Project")
                    }
                    size="lg"
                    className="shrink-0 shadow-sm"
                  />
                )}
              />
              <div className="flex flex-col flex-1 min-w-0">
                <Input
                  {...form.register("title")}
                  className="h-auto py-0.5 text-lg! font-medium leading-7 px-1 -mx-1 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all"
                  placeholder={isAgent ? "Agent Name" : "Project Name"}
                />
                <Input
                  {...form.register("description")}
                  className="h-auto py-0.5 text-base text-muted-foreground leading-6 px-1 -mx-1 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all"
                  placeholder="Add a description..."
                />
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
            <CollectionTabs
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(id) => {
                setActiveTab(id);
                localStorage.setItem("agent-detail-tab", id);
              }}
            />
            {activeTab === "connections" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={handleOpenAddDialog}
              >
                <Plus size={13} />
                Add
              </Button>
            )}
            {activeTab === "instructions" && (
              <div className="flex items-center gap-1.5">
                {!form.watch("metadata.instructions")?.trim() && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={handleInsertTemplate}
                  >
                    + Prompt template
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  disabled={!form.watch("metadata.instructions")?.trim()}
                  onClick={handleImprovePrompt}
                >
                  <Stars01 size={13} />
                  Improve
                </Button>
              </div>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto">
            {activeTab === "connections" && (
              <div className="flex flex-col gap-2 px-6 py-4">
                {connections.length === 0 ? (
                  <button
                    type="button"
                    onClick={handleOpenAddDialog}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border hover:bg-accent/50 transition-colors w-full text-left cursor-pointer"
                  >
                    <div className="flex items-center justify-center size-8 rounded-md text-muted-foreground/75 border border-dashed border-border shrink-0">
                      <Plus size={16} />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      No connections yet. Add one to get started.
                    </span>
                  </button>
                ) : (
                  connections.map((conn) => (
                    <ErrorBoundary
                      key={conn.connection_id}
                      fallback={() => null}
                    >
                      <Suspense fallback={<ConnectionItemSkeleton />}>
                        <ConnectionItem
                          connection_id={conn.connection_id}
                          selected_tools={conn.selected_tools}
                          selected_resources={conn.selected_resources}
                          selected_prompts={conn.selected_prompts}
                          onOpenSettings={() =>
                            handleOpenSettings(conn.connection_id)
                          }
                          onRemove={() =>
                            handleRemoveConnection(conn.connection_id)
                          }
                          onAuthenticate={handleAuthenticate}
                          onSwitchInstance={handleSwitchInstance}
                        />
                      </Suspense>
                    </ErrorBoundary>
                  ))
                )}
              </div>
            )}

            {activeTab === "capabilities" && isAgent && (
              <AgentCapabilities connections={connections} />
            )}

            {activeTab === "sidebar" && !isAgent && (
              <SidebarTabContent virtualMcpId={virtualMcp.id} />
            )}

            {activeTab === "instructions" && (
              <div className="p-6">
                <Controller
                  name="metadata.instructions"
                  control={form.control}
                  render={({ field }) => (
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      placeholder="Define how this agent should behave, what tone to use, any constraints or guidelines..."
                      className="min-h-[200px] resize-none text-[15px] placeholder:text-muted-foreground/40 leading-relaxed border-0 rounded-none shadow-none px-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-0 bg-transparent"
                    />
                  )}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <AddConnectionDialog
        open={dialogState.addDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: open })
        }
        addedConnectionIds={addedConnectionIds}
        onAdd={handleAddConnection}
      />

      <DependencySelectionDialog
        open={dialogState.settingsDialogOpen}
        onOpenChange={(open) => {
          if (!open) dispatch({ type: "CLOSE_SETTINGS" });
        }}
        selectedId={dialogState.settingsConnectionId}
        form={form}
        connections={connections}
        onAuthenticate={handleAuthenticate}
      />

      {isAgent && (
        <VirtualMCPShareModal
          open={dialogState.shareDialogOpen}
          onOpenChange={(open) =>
            dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: open })
          }
          virtualMcp={virtualMcp}
        />
      )}
    </ViewLayout>
  );
}

// ---------------------------------------------------------------------------
// Exported view component (route-agnostic)
// ---------------------------------------------------------------------------

export function VirtualMcpDetailView({
  virtualMcpId,
  variant,
}: {
  virtualMcpId: string;
  variant: VirtualMcpVariant;
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const virtualMcp = useVirtualMCP(virtualMcpId);

  if (!virtualMcp) {
    const label = variant === "agent" ? "Agent" : "Project";
    const backTo = variant === "agent" ? "/$org/agents" : "/$org/projects";
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title={`${label} not found`}
          description={`This ${label.toLowerCase()} may have been deleted or you may not have access.`}
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: backTo,
                  params: { org: org.slug },
                })
              }
            >
              Back to {label.toLowerCase()}s
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <VirtualMcpDetailViewWithData virtualMcp={virtualMcp} variant={variant} />
  );
}
