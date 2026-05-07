import { generatePrefixedId } from "@/shared/utils/generate-id";
import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { useChatBridge } from "@/web/components/chat/context";
import { buildImprovePromptDoc } from "@/web/components/chat/tiptap/build-improve-prompt-doc";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { useEnsureStudioPack } from "@/web/components/home/use-ensure-studio-pack";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { User } from "@/web/components/user/user";
import { useMCPAuthStatus } from "@/web/hooks/use-mcp-auth-status";

import {
  authenticateMcp,
  isConnectionAuthenticated,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card, CardContent } from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
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
  type ConnectionEntity,
  SELF_MCP_ALIAS_ID,
  StudioPackAgentId,
  useConnection,
  useConnectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Settings02,
  Settings04,
  Maximize01,
  Play,
  Plus,
  Stars01,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { Suspense, useEffect, useReducer, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
import { toast } from "sonner";
import { IconPicker } from "../../components/icon-picker";
import { SimpleIconPicker } from "../../components/simple-icon-picker";
import { Page } from "@/web/components/page";
import { AddConnectionDialog } from "./add-connection-dialog";
import { track } from "@/web/lib/posthog-client";
import { DependencySelectionDialog } from "./dependency-selection-dialog";
import { ALL_ITEMS_SELECTED } from "./selection-utils";
import {
  VirtualMcpFormSchema,
  type VirtualMcpFormData,
  type VirtualMcpFormReturn,
} from "./types";
import { VirtualMCPShareModal } from "./virtual-mcp-share-modal";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { FIXED_SYSTEM_TABS } from "@/web/layouts/main-panel-tabs/tab-id";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";

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

type EditSession = {
  start: number;
  fields: Set<string>;
  saveCount: number;
  instructionsLength: number | null;
};

type EditSessionAction =
  | {
      type: "accumulate";
      now: number;
      fields: string[];
      instructionsLength: number | null;
    }
  | { type: "reset" };

function editSessionReducer(
  state: EditSession | null,
  action: EditSessionAction,
): EditSession | null {
  switch (action.type) {
    case "accumulate": {
      const base: EditSession = state ?? {
        start: action.now,
        fields: new Set(),
        saveCount: 0,
        instructionsLength: null,
      };
      const fields = new Set(base.fields);
      for (const f of action.fields) fields.add(f);
      return {
        ...base,
        fields,
        saveCount: base.saveCount + 1,
        instructionsLength:
          action.instructionsLength ?? base.instructionsLength,
      };
    }
    case "reset":
      return null;
  }
}

/**
 * Connection Item - Card layout inspired by the reference design:
 * Body: icon + name + description (clickable → connection detail page)
 * Footer: instance selector + resources summary + edit (resource config) + remove
 */
function ConnectionItem({
  connection_id,
  usedConnectionIds,
  onOpenSettings,
  onRemove,
  onAuthenticate,
  onSwitchInstance,
  onNewInstance,
}: {
  connection_id: string;
  usedConnectionIds: Set<string>;
  onOpenSettings: () => void;
  onRemove: () => void;
  onAuthenticate: (connectionId: string) => void;
  onSwitchInstance: (oldId: string, newId: string) => void;
  onNewInstance?: () => void;
}) {
  const connection = useConnection(connection_id);
  const { org } = useProjectContext();

  if (!connection) return null;

  const slug = getConnectionSlug(connection);

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
        appName={connection.app_name}
        usedConnectionIds={usedConnectionIds}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
        onAuthenticate={onAuthenticate}
        onSwitchInstance={onSwitchInstance}
        onNewInstance={onNewInstance}
      />
    </Suspense>
  );
}

const NEW_INSTANCE_VALUE = "__new_instance__";

async function extractEmailFromTokenInfo(
  tokenInfo: {
    idToken: string | null;
    userinfoEndpoint: string | null;
    accessToken: string;
  } | null,
  accessToken: string,
): Promise<string | null> {
  // 1. Try to decode the OIDC id_token JWT (fastest, no extra request)
  const jwtToTry = tokenInfo?.idToken ?? null;
  if (jwtToTry) {
    const email = decodeJwtEmail(jwtToTry);
    if (email) return email;
  }

  // 2. Call the OIDC userinfo endpoint if available (works for Google Drive which returns opaque access tokens)
  const userinfoEndpoint = tokenInfo?.userinfoEndpoint ?? null;
  if (userinfoEndpoint) {
    try {
      const res = await fetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const userinfo = (await res.json()) as Record<string, unknown>;
        const email =
          typeof userinfo.email === "string"
            ? userinfo.email
            : typeof userinfo.upn === "string"
              ? userinfo.upn
              : typeof userinfo.preferred_username === "string"
                ? userinfo.preferred_username
                : null;
        if (email) return email;
      }
    } catch {
      // Ignore — userinfo endpoint unavailable or CORS blocked
    }
  }

  // 3. Last resort: try to decode the access token itself as a JWT
  return decodeJwtEmail(accessToken);
}

function decodeJwtEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      ) as Record<string, unknown>;
      if (typeof payload.email === "string") return payload.email;
      if (typeof payload.upn === "string") return payload.upn;
      if (typeof payload.preferred_username === "string")
        return payload.preferred_username;
    }
  } catch {
    // Not a decodable JWT
  }
  return null;
}

function SiblingInstanceSelector({
  appName,
  connectionId,
  usedConnectionIds,
  onSwitchInstance,
  onNewInstance,
}: {
  appName: string;
  connectionId: string;
  usedConnectionIds: Set<string>;
  onSwitchInstance: (oldId: string, newId: string) => void;
  onNewInstance?: () => void;
}) {
  const siblings = useConnections({
    filters: [{ column: "app_name", value: appName }],
  });

  if (siblings.length <= 1) return null;

  return (
    <Select
      value={connectionId}
      onValueChange={(newId) => {
        if (newId === NEW_INSTANCE_VALUE) {
          onNewInstance?.();
        } else {
          onSwitchInstance(connectionId, newId);
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-auto text-xs gap-1 px-2 shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {siblings.map((s) => (
          <SelectItem
            key={s.id}
            value={s.id}
            className="text-xs"
            disabled={s.id !== connectionId && usedConnectionIds.has(s.id)}
          >
            {s.title}
          </SelectItem>
        ))}
        {onNewInstance && (
          <SelectItem
            value={NEW_INSTANCE_VALUE}
            className="text-xs text-muted-foreground"
          >
            + New instance
          </SelectItem>
        )}
      </SelectContent>
    </Select>
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
  appName,
  usedConnectionIds,
  onOpenSettings,
  onRemove,
  onAuthenticate,
  onSwitchInstance,
  onNewInstance,
}: {
  connection_id: string;
  connectionTitle: string;
  connectionDescription?: string | null;
  connectionIcon?: string | null;
  connectionType: string;
  slug: string;
  orgSlug: string;
  appName?: string | null;
  usedConnectionIds: Set<string>;
  onOpenSettings: () => void;
  onRemove: () => void;
  onAuthenticate: (connectionId: string) => void;
  onSwitchInstance: (oldId: string, newId: string) => void;
  onNewInstance?: () => void;
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
        to="/$org/settings/connections/$appSlug"
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
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent text-muted-foreground shrink-0 transition-colors">
                <Settings02 size={16} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Connection settings</TooltipContent>
          </Tooltip>
        )}
      </Link>

      {/* Footer — instance selector + resources summary + edit + remove */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-muted/25">
        {/* Instance selector */}
        {appName && (
          <SiblingInstanceSelector
            appName={appName}
            connectionId={connection_id}
            usedConnectionIds={usedConnectionIds}
            onSwitchInstance={onSwitchInstance}
            onNewInstance={onNewInstance}
          />
        )}

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
                <Settings04 size={13} />
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
// Layout tab content (projects only)
// ---------------------------------------------------------------------------

interface UITool {
  name: string;
  description?: string;
}

interface PinnedView {
  connectionId: string;
  toolName: string;
  label: string;
  icon?: string | null;
}

interface ConnectionWithTools {
  fetchOk: boolean;
  id: string;
  title: string;
  icon: string | null;
  uiTools: UITool[];
}

function LayoutTabContent({
  virtualMcpId,
  form,
  flushAndSave,
}: {
  virtualMcpId: string;
  form: VirtualMcpFormReturn;
  flushAndSave: () => Promise<unknown>;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

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
              fetchOk: true,
              id: connId,
              title: item?.title ?? connId,
              icon: item?.icon ?? null,
              uiTools,
            };
          } catch {
            return {
              fetchOk: false,
              id: connId,
              title: connId,
              icon: null,
              uiTools: [],
            };
          }
        }),
      );
      return results;
    },
  });

  // Only show connections with interactive tools in the UI
  const connectionsData: ConnectionWithTools[] = (
    connectionsWithTools ?? []
  ).filter((c) => c.uiTools.length > 0);

  const fixedTabTypeSet = new Set<string>(FIXED_SYSTEM_TABS);

  // Layout state lives in the parent form under metadata.ui.{pinnedViews, layout}.
  // form.watch subscribes the component to changes from any source — direct user
  // edits, the orphan-pin reconciliation below, or a server refetch.
  const pinnedViews = form.watch("metadata.ui.pinnedViews") ?? [];
  const layoutMeta = form.watch("metadata.ui.layout") ?? null;
  const currentDefaultMain = layoutMeta?.defaultMainView ?? null;
  const chatDefaultOpen = layoutMeta?.chatDefaultOpen ?? false;

  // Convert the stored {type, id, toolName} object into the string composite
  // key used by the <Select> UI. Legacy tab types fold into "settings".
  const defaultMainView = (() => {
    if (!currentDefaultMain || currentDefaultMain.type === "chat")
      return "chat";
    if (
      currentDefaultMain.type === "instructions" ||
      currentDefaultMain.type === "connections" ||
      currentDefaultMain.type === "layout"
    ) {
      return "settings";
    }
    if (fixedTabTypeSet.has(currentDefaultMain.type)) {
      return currentDefaultMain.type;
    }
    return `${currentDefaultMain.type}:${currentDefaultMain.id ?? ""}:${currentDefaultMain.toolName ?? ""}`;
  })();

  // Inverse — converts the string composite key back to the stored object form.
  const parseDefaultMainView = (value: string) => {
    const [type, id, toolName] = value.split(":");
    if (!type) return null;
    if (type === "chat") return { type };
    if (fixedTabTypeSet.has(type)) {
      return { type };
    }
    if (type === "ext-apps" && id)
      return { type: "ext-apps" as const, id, toolName: toolName || undefined };
    return null;
  };

  const writePinned = (next: PinnedView[]) => {
    form.setValue("metadata.ui.pinnedViews", next, { shouldDirty: true });
  };

  const writeLayout = (next: {
    defaultMainView?: { type: string; id?: string; toolName?: string } | null;
    chatDefaultOpen?: boolean | null;
  }) => {
    form.setValue(
      "metadata.ui.layout",
      { ...layoutMeta, ...next },
      { shouldDirty: true },
    );
  };

  // Reconcile orphaned pinned views once tool data is available.
  // Only remove pins whose connection was successfully fetched but no longer
  // exposes the pinned tool. Pins for connections that failed to fetch are
  // kept to avoid permanent deletion from transient errors.
  const reconciledRef = useRef(false);
  if (
    connectionsWithTools &&
    connectionsWithTools.length > 0 &&
    !reconciledRef.current
  ) {
    reconciledRef.current = true;

    const fetchedOkIds = new Set(
      (connectionsWithTools ?? []).filter((c) => c.fetchOk).map((c) => c.id),
    );
    const validKeys = new Set(
      connectionsData.flatMap((c) => c.uiTools.map((t) => `${c.id}:${t.name}`)),
    );

    const validPinned = pinnedViews.filter(
      (pv) =>
        !fetchedOkIds.has(pv.connectionId) ||
        validKeys.has(`${pv.connectionId}:${pv.toolName}`),
    );

    if (validPinned.length !== pinnedViews.length) {
      writePinned(validPinned);

      // If the default view was an ext-app that got removed, reset to chat
      if (
        currentDefaultMain?.type === "ext-apps" &&
        !validPinned.some(
          (pv) =>
            pv.connectionId === currentDefaultMain.id &&
            pv.toolName === currentDefaultMain.toolName,
        )
      ) {
        writeLayout({ defaultMainView: { type: "chat" } });
      }
    }
  }

  const handleTogglePin = (connectionId: string, toolName: string) => {
    const pinned = pinnedViews.some(
      (v) => v.connectionId === connectionId && v.toolName === toolName,
    );
    if (pinned) {
      const nextPinned = pinnedViews.filter(
        (v) => !(v.connectionId === connectionId && v.toolName === toolName),
      );
      writePinned(nextPinned);
      // If the unpinned view was the default, reset to chat
      const unpinnedKey = `ext-apps:${connectionId}:${toolName}`;
      if (defaultMainView === unpinnedKey) {
        writeLayout({ defaultMainView: { type: "chat" } });
      }
    } else {
      writePinned([
        ...pinnedViews,
        {
          connectionId,
          toolName,
          label: toTitleCase(toolName),
          icon: null,
        },
      ]);
    }
    flushAndSave();
  };

  const handleLabelChange = (
    connectionId: string,
    toolName: string,
    label: string,
  ) => {
    writePinned(
      pinnedViews.map((v) =>
        v.connectionId === connectionId && v.toolName === toolName
          ? { ...v, label }
          : v,
      ),
    );
  };

  const handleLabelBlur = () => {
    flushAndSave();
  };

  const handleIconChange = (
    connectionId: string,
    toolName: string,
    icon: string | null,
  ) => {
    writePinned(
      pinnedViews.map((v) =>
        v.connectionId === connectionId && v.toolName === toolName
          ? { ...v, icon }
          : v,
      ),
    );
    flushAndSave();
  };

  const handleDefaultMainViewChange = (value: string) => {
    writeLayout({ defaultMainView: parseDefaultMainView(value) });
    flushAndSave();
  };

  const noConnections = connectionIds.length === 0;
  const noInteractiveTools =
    connectionsWithTools && connectionsData.length === 0;

  // Check if virtual MCP has an active GitHub repo (enables preview)
  const hasGithubRepo = !!getActiveGithubRepo(virtualMcp);

  // Build options for the default main view selector.
  // Order mirrors the right-panel tab order in the unified chat layout:
  // Chat (no main panel), then fixed system tabs, then pinned ext-apps.
  // Terminal and Preview are gated behind an active GitHub repo,
  // matching the gating in main-panel-tabs/index.tsx.
  const defaultMainOptions: { value: string; label: string }[] = [
    { value: "chat", label: "Chat" },
    { value: "settings", label: "Settings" },
    { value: "automations", label: "Automations" },
  ];
  if (hasGithubRepo) {
    defaultMainOptions.push({ value: "env", label: "Terminal" });
    defaultMainOptions.push({ value: "preview", label: "Preview" });
  }
  for (const pv of pinnedViews) {
    defaultMainOptions.push({
      value: `ext-apps:${pv.connectionId}:${pv.toolName}`,
      label: pv.label || pv.toolName,
    });
  }

  const hasPinnedContent =
    connectionsData.length > 0 || noConnections || noInteractiveTools;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Layout</h2>
      </div>
      <Card className="p-6 gap-5">
        <CardContent className="p-0 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <Label className="font-normal text-foreground">Main view</Label>
              <p className="text-xs text-muted-foreground">
                What users see when they first open this agent.
              </p>
            </div>
            <Select
              value={defaultMainView}
              onValueChange={handleDefaultMainViewChange}
            >
              <SelectTrigger className="w-44 h-8 text-sm capitalize shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {defaultMainOptions.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    className="capitalize"
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <Label className="font-normal text-foreground">Show chat</Label>
              <p className="text-xs text-muted-foreground">
                Display the chat panel alongside the main view.
              </p>
            </div>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <span className="shrink-0">
                  <Switch
                    checked={
                      defaultMainView === "chat" ? true : chatDefaultOpen
                    }
                    disabled={defaultMainView === "chat"}
                    onCheckedChange={(checked) => {
                      writeLayout({ chatDefaultOpen: checked });
                      flushAndSave();
                    }}
                  />
                </span>
              </TooltipTrigger>
              {defaultMainView === "chat" && (
                <TooltipContent side="top">
                  Chat is always shown when it is the default view
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </CardContent>

        {hasPinnedContent && (
          <>
            <div className="border-t border-border -mx-6" />
            <CardContent className="p-0 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5 min-w-0">
                  <Label className="font-normal text-foreground">
                    Pinned views
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Surface interactive tools as top-level tabs in the agent.
                  </p>
                </div>
              </div>
              {noConnections && (
                <p className="text-xs text-muted-foreground">
                  Add a connection above to configure pinned views.
                </p>
              )}
              {noInteractiveTools && !noConnections && (
                <p className="text-xs text-muted-foreground">
                  None of the connected servers expose interactive tools.
                </p>
              )}
              {connectionsData.length > 0 && (
                <div className="space-y-4 pt-1">
                  {connectionsData.map((conn, connIdx) => (
                    <div key={conn.id}>
                      {connIdx > 0 && (
                        <div className="border-t border-border -mx-6 mb-4" />
                      )}
                      <div className="flex items-center gap-2 mb-2.5">
                        <IntegrationIcon
                          icon={conn.icon}
                          name={conn.title}
                          size="xs"
                          className="shrink-0"
                        />
                        <span className="text-xs font-medium text-muted-foreground">
                          {conn.title}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {conn.uiTools.map((tool) => {
                          const pinned = pinnedViews.some(
                            (v) =>
                              v.connectionId === conn.id &&
                              v.toolName === tool.name,
                          );
                          const pinnedView = pinnedViews.find(
                            (v) =>
                              v.connectionId === conn.id &&
                              v.toolName === tool.name,
                          );
                          return (
                            <div
                              key={tool.name}
                              className={cn(
                                "flex items-center justify-between gap-3 px-3 py-2 rounded-lg border transition-colors",
                                pinned
                                  ? "bg-accent/40 border-border"
                                  : "bg-transparent border-border",
                              )}
                            >
                              <div className="min-w-0 flex-1 flex items-center gap-2">
                                <SimpleIconPicker
                                  value={pinnedView?.icon ?? null}
                                  onChange={(icon) =>
                                    handleIconChange(conn.id, tool.name, icon)
                                  }
                                  disabled={!pinned}
                                />
                                <Input
                                  value={
                                    pinned && pinnedView
                                      ? pinnedView.label
                                      : toTitleCase(tool.name)
                                  }
                                  onChange={(e) =>
                                    handleLabelChange(
                                      conn.id,
                                      tool.name,
                                      e.target.value,
                                    )
                                  }
                                  onBlur={handleLabelBlur}
                                  className="h-7 text-sm w-40"
                                  disabled={!pinned}
                                  readOnly={!pinned}
                                />
                              </div>
                              <Switch
                                checked={pinned}
                                onCheckedChange={() =>
                                  handleTogglePin(conn.id, tool.name)
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Main detail view
// ---------------------------------------------------------------------------

function VirtualMcpDetailViewWithData({
  virtualMcp,
  hideOwnTitle,
}: {
  virtualMcp: VirtualMCPEntity;
  hideOwnTitle?: boolean;
}) {
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Form setup
  const form = useForm<VirtualMcpFormData>({
    resolver: zodResolver(VirtualMcpFormSchema),
    defaultValues: virtualMcp,
  });

  // Watch connections for reactive UI
  const connections = form.watch("connections");

  // GitHub repo connected — instructions become read-only
  const hasGithubRepo = !!getActiveGithubRepo(virtualMcp);

  // Dialog states
  const [dialogState, dispatch] = useReducer(dialogReducer, {
    shareDialogOpen: false,
    addDialogOpen: false,
    settingsDialogOpen: false,
    settingsConnectionId: null,
  });

  const [instructionsFullscreen, setInstructionsFullscreen] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const { createNewTask, setChatOpen } = usePanelActions();
  const { sendMessage } = useChatBridge();
  const ensureStudioPack = useEnsureStudioPack();

  const handleImprovePrompt = async () => {
    if (isImproving) return;
    const currentInstructions = form.getValues("metadata.instructions");
    if (!currentInstructions?.trim()) return;

    setIsImproving(true);
    try {
      forceSessionFlush();
      track("agent_instructions_improve_clicked", {
        agent_id: virtualMcp.id,
        instructions_length: currentInstructions.length,
      });

      await ensureStudioPack(["studio-agent-manager"]);

      setChatOpen(true);

      await sendMessage({
        tiptapDoc: buildImprovePromptDoc({
          managerAgentId: StudioPackAgentId.AGENT_MANAGER(org.id),
          managerName: "Agent Manager",
          kind: "agent",
          id: virtualMcp.id,
          instructions: currentInstructions,
        }),
      });
    } finally {
      setIsImproving(false);
    }
  };

  const handleTestAgent = () => {
    forceSessionFlush();
    track("agent_test_clicked", { agent_id: virtualMcp.id });
    createNewTask();
  };

  // Session-based tracking for agent_updated. Auto-saves persist every ~1s but
  // we only emit one PostHog event per edit-session (aggregated fields +
  // save_count + edit_duration_ms). A session ends after 30s of quiet.
  const [editSession, dispatchEditSession] = useReducer(
    editSessionReducer,
    null,
  );

  const flushEditSession = () => {
    if (editSession === null) return;
    track("agent_updated", {
      agent_id: virtualMcp.id,
      fields: Array.from(editSession.fields),
      instructions_length: editSession.instructionsLength,
      save_count: editSession.saveCount,
      edit_duration_ms: Date.now() - editSession.start,
    });
    dispatchEditSession({ type: "reset" });
  };

  const { schedule: scheduleSessionFlush, flush: forceSessionFlush } =
    useDebouncedAutosave({
      delayMs: 30_000,
      save: async () => flushEditSession(),
    });

  const saveForm = async () => {
    // form.formState is a Proxy over React state. When saveForm runs
    // synchronously after setValue (e.g. via flushAndSave), React hasn't
    // processed the batched state update yet and form.formState.dirtyFields
    // returns the previous render's snapshot — empty on the first edit — so
    // the save would bail. Read control._formState.dirtyFields for the live,
    // synchronously-updated value.
    const dirtyKeys = Object.keys(
      (
        form.control as unknown as {
          _formState: { dirtyFields: Record<string, unknown> };
        }
      )._formState.dirtyFields,
    );
    if (dirtyKeys.length === 0) return;
    const instructionsDirty = dirtyKeys.includes("metadata");

    const formData = form.getValues();
    // Rebase the dirty baseline to the snapshot we're about to send so that
    // an edit during the in-flight save that returns a value to its pre-save
    // default still registers as dirty. keepValues preserves the user's
    // current form values; only _defaultValues advances.
    form.reset(formData, { keepValues: true });

    await actions.update.mutateAsync({
      id: virtualMcp.id,
      data: formData,
      silent: true,
    });

    // Accumulate into the current edit session and (re)schedule a flush
    // 30s after the last save.
    dispatchEditSession({
      type: "accumulate",
      now: Date.now(),
      fields: dirtyKeys,
      instructionsLength: instructionsDirty
        ? (formData.metadata?.instructions?.length ?? 0)
        : null,
    });
    scheduleSessionFlush();
  };

  const { schedule: debouncedSave, flush: flushAndSave } = useDebouncedAutosave(
    { save: saveForm },
  );

  // form.watch(callback) fires whenever a value changes via setValue, but not
  // on form.reset({ keepValues: true }) (which only emits state, no `values`
  // key) — so saveForm's pre-mutate rebase does NOT loop. Edit handlers
  // can just call form.setValue and trust this subscription to schedule the
  // save. flushAndSave remains for explicit "save NOW" semantics (blurs,
  // toggles).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const sub = form.watch(() => debouncedSave());
    return () => sub.unsubscribe();
    // debouncedSave is stable for our purpose: its closure only mediates
    // through stable refs inside useDebouncedAutosave, so the mount-time
    // reference stays valid for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenAddDialog = () => {
    track("connections_dialog_opened", {
      source: "agent_settings",
      mode: "add",
    });
    dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: true });
  };

  const handleAddConnection = async (connectionId: string) => {
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
    dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: false });

    // Auto-trigger OAuth if the connection needs authorization
    const mcpProxyUrl = new URL(
      `/api/${org.slug}/mcp/${connectionId}`,
      window.location.origin,
    );
    const authStatus = await isConnectionAuthenticated({
      url: mcpProxyUrl.href,
      token: null,
      orgId: org.id,
    });
    if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
      await handleAuthenticate(connectionId);
    }
  };

  const handleRemoveConnection = (connectionId: string) => {
    const current = form.getValues("connections");
    const filtered = current.filter((c) => c.connection_id !== connectionId);
    form.setValue("connections", filtered, { shouldDirty: true });
  };

  const handleSwitchInstance = (oldId: string, newId: string) => {
    const current = form.getValues("connections");
    // Prevent switching to an instance already used in this agent
    if (current.some((c) => c.connection_id === newId)) {
      toast.error("This instance is already added to the agent");
      return;
    }
    form.setValue(
      "connections",
      current.map((c) =>
        c.connection_id === oldId ? { ...c, connection_id: newId } : c,
      ),
      { shouldDirty: true },
    );
  };

  const handleNewInstance = async (connectionId: string) => {
    const connection = form
      .getValues("connections")
      .find((c) => c.connection_id === connectionId);
    if (!connection) return;

    // We need the full connection entity to clone from
    try {
      const result = await client.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: connectionId },
      });
      const { item: base } = (result.structuredContent ?? {}) as {
        item: ConnectionEntity | null;
      };
      if (!base) return;

      const baseName = base.title.replace(/\s*\(.*?\)\s*$/, "");
      const newId = generatePrefixedId("conn");
      // Temporary title — will be updated with email suffix after OAuth if available
      const tempTitle = `${baseName} (${Date.now().toString(36).slice(-4)})`;

      await connectionActions.create.mutateAsync({
        id: newId,
        title: tempTitle,
        description: base.description ?? null,
        connection_type: base.connection_type,
        connection_url: base.connection_url ?? null,
        connection_token: null,
        icon: base.icon ?? null,
        app_name: base.app_name ?? null,
        app_id: base.app_id ?? null,
        connection_headers: base.connection_headers ?? null,
      });

      // Handle OAuth if needed
      const mcpProxyUrl = new URL(
        `/api/${org.slug}/mcp/${newId}`,
        window.location.origin,
      );
      const authStatus = await isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
        orgId: org.id,
      });
      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const email = await handleAuthenticate(newId);
        if (!email) {
          // Auth failed or cancelled — clean up the orphaned connection
          await connectionActions.delete.mutateAsync(newId);
          return;
        }
        await connectionActions.update.mutateAsync({
          id: newId,
          data: { title: `${baseName} (${email})` },
        });
      }

      // Switch to the new instance
      handleSwitchInstance(connectionId, newId);
      toast.success("New instance created");
    } catch (err) {
      console.error("Failed to create instance:", err);
      toast.error("Failed to create instance");
    }
  };

  const handleOpenSettings = (connectionId: string) => {
    dispatch({ type: "OPEN_SETTINGS", payload: connectionId });
  };

  const handleAuthenticate = async (
    connectionId: string,
  ): Promise<string | null> => {
    const { token, tokenInfo, error } = await authenticateMcp({
      connectionId,
      orgSlug: org.slug,
      scope: "offline_access",
    });
    if (error || !token) {
      toast.error(`Authentication failed: ${error}`);
      return null;
    }

    if (tokenInfo) {
      try {
        const response = await fetch(
          `/api/${org.slug}/connections/${connectionId}/oauth-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
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

    const mcpProxyUrl = new URL(
      `/api/${org.slug}/mcp/${connectionId}`,
      window.location.origin,
    );
    await queryClient.invalidateQueries({
      queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
    });

    toast.success("Authentication successful");

    return extractEmailFromTokenInfo(tokenInfo, token);
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

  const addedConnectionIds = new Set(connections.map((c) => c.connection_id));
  const navigate = useNavigate();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleDelete = async () => {
    forceSessionFlush();
    try {
      await actions.delete.mutateAsync(virtualMcp.id);
      track("agent_deleted", {
        agent_id: virtualMcp.id,
        source: "agent_detail",
      });
      toast.success(`Deleted "${virtualMcp.title}"`);
      navigate({ to: "/$org", params: { org: org.slug } });
    } catch {
      // Error toast handled by mutation
    }
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-10">
            {!hideOwnTitle && (
              <Page.Title
                actions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTestAgent}
                    >
                      <Play size={14} className="!size-[14px]" />
                      Test Agent
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash01 size={14} />
                    </Button>
                  </div>
                }
              >
                Settings
              </Page.Title>
            )}

            {/* Agent identity header */}
            <div className="flex items-center gap-3">
              <Controller
                name="icon"
                control={form.control}
                render={({ field }) => (
                  <IconPicker
                    value={field.value ?? null}
                    onChange={(icon) => {
                      field.onChange(icon);
                      flushAndSave();
                    }}
                    onColorChange={(color) => {
                      form.setValue("metadata.ui.themeColor", color, {
                        shouldDirty: true,
                      });
                      flushAndSave();
                    }}
                    name={form.watch("title") || "Agent"}
                    size="md"
                    className="shrink-0"
                    avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
                    disabled={hasGithubRepo}
                  />
                )}
              />
              <div className="flex flex-col flex-1 min-w-0">
                <Controller
                  name="title"
                  control={form.control}
                  render={({ field }) => (
                    <input
                      {...field}
                      type="text"
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      onBlur={() => {
                        field.onBlur();
                        flushAndSave();
                      }}
                      disabled={hasGithubRepo}
                      placeholder="Agent name"
                      className="text-lg font-medium leading-tight text-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-full truncate disabled:hover:bg-transparent disabled:focus:bg-transparent disabled:opacity-50"
                    />
                  )}
                />
                <Controller
                  name="description"
                  control={form.control}
                  render={({ field }) => (
                    <input
                      {...field}
                      type="text"
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      onBlur={() => {
                        field.onBlur();
                        flushAndSave();
                      }}
                      disabled={hasGithubRepo}
                      placeholder="Add a description..."
                      className="text-sm text-muted-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-full truncate disabled:hover:bg-transparent disabled:focus:bg-transparent disabled:opacity-50"
                    />
                  )}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  track("agent_connect_modal_opened", {
                    agent_id: virtualMcp.id,
                  });
                  dispatch({
                    type: "SET_SHARE_DIALOG_OPEN",
                    payload: true,
                  });
                }}
              >
                <span className="flex items-center -space-x-1.5 mr-0.5">
                  <span className="inline-flex items-center justify-center size-4 rounded-full bg-black ring-1 ring-white/20 shrink-0">
                    <img
                      src="/logos/cursor.svg"
                      alt="Cursor"
                      className="size-2.5 brightness-0 invert"
                    />
                  </span>
                  <span
                    className="relative z-10 inline-flex items-center justify-center size-4 rounded-full ring-1 ring-background shrink-0"
                    style={{ backgroundColor: "#D97757" }}
                  >
                    <img
                      src="/logos/Claude Code.svg"
                      alt="Claude"
                      className="size-2.5 brightness-0 invert"
                    />
                  </span>
                </span>
                Connect
              </Button>
            </div>

            {/* Creator metadata */}
            <div className="flex items-center gap-2 -mt-6 text-muted-foreground">
              <User
                id={virtualMcp.created_by}
                size="2xs"
                className="text-sm text-muted-foreground"
              />
              <span className="text-muted-foreground/50 text-sm">·</span>
              <span className="text-sm">
                {new Date(virtualMcp.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </div>

            {/* Connections section */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  Connections
                </h2>
                {connections.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenAddDialog}
                  >
                    <Plus size={14} />
                    Add connection
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2">
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
                          usedConnectionIds={addedConnectionIds}
                          onOpenSettings={() =>
                            handleOpenSettings(conn.connection_id)
                          }
                          onRemove={() =>
                            handleRemoveConnection(conn.connection_id)
                          }
                          onAuthenticate={handleAuthenticate}
                          onSwitchInstance={handleSwitchInstance}
                          onNewInstance={() =>
                            handleNewInstance(conn.connection_id)
                          }
                        />
                      </Suspense>
                    </ErrorBoundary>
                  ))
                )}
              </div>
            </section>

            {/* Instructions section */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  Instructions
                </h2>
                {!hasGithubRepo && (
                  <div className="flex items-center gap-2">
                    {!form.watch("metadata.instructions")?.trim() && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleInsertTemplate}
                      >
                        + Prompt template
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        isImproving ||
                        !form.watch("metadata.instructions")?.trim()
                      }
                      onClick={handleImprovePrompt}
                    >
                      <Stars01 size={13} />
                      Improve
                    </Button>
                  </div>
                )}
              </div>
              <Controller
                name="metadata.instructions"
                control={form.control}
                render={({ field }) => (
                  <div className="relative rounded-xl card-shadow bg-card focus-within:ring-1 focus-within:ring-ring">
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      onBlur={() => {
                        field.onBlur();
                        flushAndSave();
                      }}
                      disabled={hasGithubRepo}
                      placeholder="Define how this agent should behave, what tone to use, any constraints or guidelines..."
                      className="min-h-[200px] max-h-[360px] overflow-auto resize-none text-base text-muted-foreground placeholder:text-muted-foreground/40 leading-relaxed border-0 shadow-none px-4 py-3 pr-11 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
                      style={{ boxShadow: "none" }}
                    />
                    <Tooltip delayDuration={0}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-2 right-2 h-7 w-7 text-muted-foreground"
                          onClick={() => setInstructionsFullscreen(true)}
                          aria-label="Open fullscreen editor"
                        >
                          <Maximize01 size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Fullscreen</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              />
            </section>

            {/* Layout section */}
            <LayoutTabContent
              virtualMcpId={virtualMcp.id}
              form={form}
              flushAndSave={flushAndSave}
            />

            {/* Danger zone */}
            <section className="flex items-center justify-between border-t border-border pt-6">
              <div>
                <p className="text-sm font-medium">Delete agent</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this agent and all its data.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive shrink-0"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash01 size={14} />
                Delete agent
              </Button>
            </section>
          </div>
        </Page.Body>
      </Page.Content>

      {/* Dialogs */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {virtualMcp.title}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddConnectionDialog
        open={dialogState.addDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: open })
        }
        agentId={virtualMcp.id}
        addedConnectionIds={addedConnectionIds}
        onAdd={handleAddConnection}
      />

      <DependencySelectionDialog
        open={dialogState.settingsDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "CLOSE_SETTINGS" });
          }
        }}
        selectedId={dialogState.settingsConnectionId}
        form={form}
        connections={connections}
        onAuthenticate={handleAuthenticate}
      />

      <VirtualMCPShareModal
        open={dialogState.shareDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: open })
        }
        virtualMcp={virtualMcp}
      />

      <Dialog
        open={instructionsFullscreen}
        onOpenChange={setInstructionsFullscreen}
      >
        <DialogContent className="w-[90vw] sm:max-w-6xl h-[85vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-border shrink-0">
            <DialogTitle>Instructions</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 p-6">
            <Controller
              name="metadata.instructions"
              control={form.control}
              render={({ field }) => (
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    field.onChange(e);
                  }}
                  onBlur={() => {
                    field.onBlur();
                    flushAndSave();
                  }}
                  disabled={hasGithubRepo}
                  placeholder="Define how this agent should behave, what tone to use, any constraints or guidelines..."
                  className="w-full h-full resize-none text-base text-muted-foreground placeholder:text-muted-foreground/40 leading-relaxed rounded-xl card-shadow px-4 py-3 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 bg-card border-0"
                  style={{ boxShadow: "none" }}
                />
              )}
            />
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Exported view component (route-agnostic)
// ---------------------------------------------------------------------------

export function VirtualMcpDetailView({
  virtualMcpId,
  hideOwnTitle,
}: {
  virtualMcpId: string;
  hideOwnTitle?: boolean;
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const virtualMcp = useVirtualMCP(virtualMcpId);
  if (!virtualMcp) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title="Space not found"
          description="This space may have been deleted or you may not have access."
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/$org",
                  params: { org: org.slug },
                })
              }
            >
              Back to spaces
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <VirtualMcpDetailViewWithData
      key={getActiveGithubRepo(virtualMcp)?.connectionId ?? ""}
      virtualMcp={virtualMcp}
      hideOwnTitle={hideOwnTitle}
    />
  );
}
