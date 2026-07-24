import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { FIXED_SYSTEM_TABS } from "@/layouts/main-panel-tabs/tab-id";
import { useT } from "@/i18n/use-t.ts";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useVirtualMCP } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { SimpleIconPicker } from "../../components/simple-icon-picker";
import type { VirtualMcpFormReturn } from "./types";

interface UITool {
  name: string;
  title?: string;
  description?: string;
  resourceUri: string;
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

export function LayoutTabContent({
  virtualMcpId,
  form,
  flushAndSave,
}: {
  virtualMcpId: string;
  form: VirtualMcpFormReturn;
  flushAndSave: () => Promise<unknown>;
}) {
  const t = useT();
  const studio = useStudioTools();

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
            const { item } = await studio.call("COLLECTION_CONNECTIONS_GET", {
              id: connId,
            });
            const uiTools: UITool[] = (item?.tools ?? []).flatMap((t) => {
              const resourceUri = getUIResourceUri(t._meta);
              if (!resourceUri) return [];
              return [
                {
                  name: t.name,
                  title: t.title,
                  description: t.description,
                  resourceUri,
                },
              ];
            });
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
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    !reconciledRef.current
  ) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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
      const toolTitle = connectionsData
        .find((c) => c.id === connectionId)
        ?.uiTools.find((t) => t.name === toolName)?.title;
      writePinned([
        ...pinnedViews,
        {
          connectionId,
          toolName,
          label: toolTitle ?? toTitleCase(toolName),
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

  // Preview is available whenever the agent has a clonable source —
  // either a Start Website template or a connected GitHub repo — matching
  // the gating in `use-main-panel-tabs.ts`.
  const hasClonableSource = agentHasClonableSource(virtualMcp?.metadata);

  // Build options for the default main view selector.
  // Order mirrors the right-panel tab order in the unified chat layout:
  // Chat (no main panel), then fixed system tabs, then pinned ext-apps.
  const defaultMainOptions: { value: string; label: string }[] = [
    { value: "chat", label: t("virtualMcp.layoutTabContent.chat") },
    { value: "settings", label: t("virtualMcp.layoutTabContent.settings") },
    {
      value: "automations",
      label: t("virtualMcp.layoutTabContent.automations"),
    },
  ];
  if (hasClonableSource) {
    defaultMainOptions.push({
      value: "preview",
      label: t("virtualMcp.layoutTabContent.preview"),
    });
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
        <h2 className="text-sm font-medium text-foreground">
          {t("virtualMcp.layoutTabContent.layout")}
        </h2>
      </div>
      <Card className="p-6 gap-5">
        <CardContent className="p-0 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <Label className="font-normal text-foreground">
                {t("virtualMcp.layoutTabContent.mainView")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("virtualMcp.layoutTabContent.mainViewDescription")}
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
              <Label className="font-normal text-foreground">
                {t("virtualMcp.layoutTabContent.showChat")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("virtualMcp.layoutTabContent.showChatDescription")}
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
                  {t("virtualMcp.layoutTabContent.chatAlwaysShown")}
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
                    {t("virtualMcp.layoutTabContent.pinnedViews")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("virtualMcp.layoutTabContent.pinnedViewsDescription")}
                  </p>
                </div>
              </div>
              {noConnections && (
                <p className="text-xs text-muted-foreground">
                  {t("virtualMcp.layoutTabContent.addConnectionMessage")}
                </p>
              )}
              {noInteractiveTools && !noConnections && (
                <p className="text-xs text-muted-foreground">
                  {t("virtualMcp.layoutTabContent.noInteractiveTools")}
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
                                      : (tool.title ?? toTitleCase(tool.name))
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
