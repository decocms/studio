/**
 * Everything the project's views need, once.
 *
 * State and writers for the Views card: which views this project can open,
 * which are pinned, and where it lands. The renderer stays dumb, and the hook
 * is called ONCE by the settings view — two copies would each stage their own
 * optimistic revision.
 */

import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";
import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  DESTINATION_MAIN_VIEWS,
  FIXED_SYSTEM_TABS,
  normalizePanelSegment,
} from "@/layouts/main-panel-tabs/tab-id";
import { useT } from "@/i18n/use-t.ts";
import { useVirtualMCP } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { VirtualMcpFormReturn } from "../types";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useProjectNativeViewPresence } from "@/layouts/main-panel-tabs/use-project-native-view-presence";
import {
  availableProjectSidebarViews,
  defaultMainViewAfterSidebarToggle,
  effectiveProjectSidebarViews,
  projectSidebarViewPresence,
  resolveProjectSidebarViews,
  selectedProjectSidebarViews,
  toggleProjectSidebarView,
  type ProjectSidebarViewId,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import {
  useOptimisticProjectSidebarViews,
  useOptimisticProjectSidebarViewsActions,
} from "@/layouts/main-panel-tabs/optimistic-project-sidebar-views";

/** The merged landing view: the surface Preview, Content and Code are tabs on. */
const SITE_EDITOR_VIEW = "site-editor";

/** Stored `defaultMainView.type` values that all mean "land on the Site
 *  Editor" — its own id, and `content`, which was a sibling option before the
 *  three views became tabs on one surface. */
const SITE_EDITOR_VIEW_TYPES: ReadonlySet<string> = new Set([
  SITE_EDITOR_VIEW,
  "content",
]);

interface UITool {
  name: string;
  title?: string;
  description?: string;
  resourceUri: string;
}

export interface PinnedView {
  connectionId: string;
  toolName: string;
  label: string;
  icon?: string | null;
}

export interface ConnectionWithTools {
  fetchOk: boolean;
  id: string;
  title: string;
  icon: string | null;
  uiTools: UITool[];
}

export type ProjectViews = ReturnType<typeof useProjectViews>;

export function useProjectViews({
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
  const { openPanel } = usePanelNavigate();

  const virtualMcp = useVirtualMCP(virtualMcpId);
  const nativeViews = useProjectNativeViewPresence(virtualMcp);
  const optimisticSidebarViews =
    useOptimisticProjectSidebarViewsActions(virtualMcpId);
  const pendingSidebarViews = useOptimisticProjectSidebarViews(virtualMcpId);

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

  /** What `defaultMainView.type` may hold: a tab on the bar, or one of the
   *  destinations an agent can land on instead. */
  const fixedTabTypeSet = new Set<string>([
    ...FIXED_SYSTEM_TABS,
    ...DESTINATION_MAIN_VIEWS,
  ]);

  /**
   * Layout state lives in the parent form under metadata.ui.{pinnedViews, layout}.
   * form.watch subscribes the component to changes from any source — direct user
   * edits, the orphan-pin reconciliation below, or a server refetch.
   */
  const pinnedViews = form.watch("metadata.ui.pinnedViews") ?? [];
  const layoutMeta = form.watch("metadata.ui.layout") ?? null;
  const currentDefaultMain = layoutMeta?.defaultMainView ?? null;
  const chatDefaultOpen = layoutMeta?.chatDefaultOpen ?? false;
  const formSidebarViews = effectiveProjectSidebarViews(
    resolveProjectSidebarViews({
      sidebarViews: form.watch("metadata.sidebarViews"),
      ui: { layout: layoutMeta },
    }),
    form.watch("metadata.sidebarViewsVersion"),
  );
  /**
   * A Settings panel can remount while its previous instance is still saving.
   * Pending edits and the item cache outlive that form, so they remain the
   * switch authority instead of stale remounted defaults.
   */
  const sidebarViews =
    pendingSidebarViews ??
    (virtualMcp
      ? effectiveProjectSidebarViews(
          resolveProjectSidebarViews(virtualMcp.metadata),
          virtualMcp.metadata.sidebarViewsVersion,
        )
      : formSidebarViews);
  /** No main view: the chat is the whole workspace, so its switch is forced on
   *  and locked. This was the old `chat` main view, which no longer exists. */
  /**
   * Convert the stored {type, id, toolName} object into the string composite
   * key used by the <Select> UI. Legacy tab types fold into "settings".
   */
  const defaultMainView = (() => {
    /** Chat is retired as a main view. An agent still stored on it — or on
     *  nothing — selects no option, so the trigger shows its placeholder rather
     *  than naming a view the agent does not actually open on. */
    if (!currentDefaultMain || currentDefaultMain.type === "chat") return "";
    /** Stored rows predate the `preview` → `site-editor` rename. */
    const type = normalizePanelSegment(currentDefaultMain.type);
    if (
      type === "instructions" ||
      type === "connections" ||
      type === "layout"
    ) {
      return "settings";
    }
    /** …and predate the merge, so a stored `content` selects the option that
     *  now owns that surface rather than rendering a blank trigger. */
    if (SITE_EDITOR_VIEW_TYPES.has(type)) return SITE_EDITOR_VIEW;
    if (fixedTabTypeSet.has(type)) {
      return type;
    }
    return `${type}:${currentDefaultMain.id ?? ""}:${currentDefaultMain.toolName ?? ""}`;
  })();

  const noMainView = defaultMainView === "";

  // Inverse — converts the string composite key back to the stored object form.
  const parseDefaultMainView = (value: string) => {
    const [type, id, toolName] = value.split(":");
    if (!type) return null;

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

  /**
   * Reconcile orphaned pinned views once tool data is available.
   * Drop pins whose connection is detached from the agent, or which fetched
   * OK but no longer expose the pinned tool. Pins for attached connections
   * that failed to fetch are kept to survive transient errors.
   */
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

    const attachedIds = new Set(connectionIds);
    const validPinned = pinnedViews.filter(
      (pv) =>
        attachedIds.has(pv.connectionId) &&
        (!fetchedOkIds.has(pv.connectionId) ||
          validKeys.has(`${pv.connectionId}:${pv.toolName}`)),
    );

    if (validPinned.length !== pinnedViews.length) {
      writePinned(validPinned);

      /**
       * If the default view was an ext-app that got removed, use the permanent
       * Settings view instead.
       */
      if (
        currentDefaultMain?.type === "ext-apps" &&
        !validPinned.some(
          (pv) =>
            pv.connectionId === currentDefaultMain.id &&
            pv.toolName === currentDefaultMain.toolName,
        )
      ) {
        writeLayout({ defaultMainView: { type: "settings" } });
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
      // If the unpinned view was the default, use the permanent Settings view.
      const unpinnedKey = `ext-apps:${connectionId}:${toolName}`;
      if (defaultMainView === unpinnedKey) {
        writeLayout({ defaultMainView: { type: "settings" } });
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

  const handleSidebarViewChange = (
    viewId: ProjectSidebarViewId,
    enabled: boolean,
  ) => {
    const nextSidebarViews = toggleProjectSidebarView(
      sidebarViews,
      viewId,
      enabled,
      1,
    );
    form.setValue("metadata.sidebarViews", nextSidebarViews, {
      shouldDirty: true,
    });
    form.setValue("metadata.sidebarViewsVersion", 1, { shouldDirty: true });
    optimisticSidebarViews.stage(nextSidebarViews, sidebarViews);
    const nextDefaultMain = defaultMainViewAfterSidebarToggle(
      currentDefaultMain,
      viewId,
      enabled,
    );
    if (nextDefaultMain !== currentDefaultMain) {
      writeLayout({ defaultMainView: nextDefaultMain });
    }
    /**
     * The parent form subscription coalesces rapid adjacent switch changes and
     * flushes the latest value on unmount. Starting a full metadata write for
     * every click would let out-of-order responses revert the newest choice.
     */
  };

  /**
   * Preview is available whenever the agent has a clonable source —
   * either a Start Website template or a connected GitHub repo — matching
   * the gating in `use-main-panel-tabs.ts`.
   */
  const hasClonableSource = agentHasClonableSource(virtualMcp?.metadata);
  const sidebarViewPresence = projectSidebarViewPresence(
    hasClonableSource,
    nativeViews.presence,
  );
  const availableSidebarViews =
    availableProjectSidebarViews(sidebarViewPresence);
  const enabledSidebarViews = selectedProjectSidebarViews(
    sidebarViews,
    sidebarViewPresence,
    1,
  );
  const sidebarViewLabels: Record<ProjectSidebarViewId, string> = {
    overview: t("sidebar.navDestinations.home"),
    reports: t("sidebar.navDestinations.reports"),
    board: t("sidebar.navDestinations.tasks"),
    "site-editor": t("virtualMcp.layoutTabContent.siteEditor"),
    assets: t("common.mainPanelTabs.assets"),
    hosting: t("common.mainPanelTabs.hosting"),
    e2e: t("common.mainPanelTabs.e2e"),
    analytics: t("common.mainPanelTabs.analytics"),
    cdn: t("common.mainPanelTabs.cdn"),
    automations: t("virtualMcp.layoutTabContent.automations"),
  };

  /**
   * Options in SIDEBAR order, so the list of places an agent can land reads the
   * same here as in the nav a person actually uses: the org destinations
   * (`NAV_DESTINATION_KEYS` — Home, Reports, Tasks; Library is org-only and
   * never an agent's view), then the project rows, then Settings last.
   */
  const defaultMainOptions: { value: string; label: string }[] = [];
  for (const viewId of enabledSidebarViews) {
    /**
     * Pinned app rows sit before Automations in the actual sidebar, so append
     * that final project row after the pinned-view loop below.
     */
    if (viewId === "automations") continue;
    defaultMainOptions.push({
      value: viewId,
      label: sidebarViewLabels[viewId],
    });
  }
  for (const pv of pinnedViews) {
    defaultMainOptions.push({
      value: `ext-apps:${pv.connectionId}:${pv.toolName}`,
      label: pv.label || pv.toolName,
    });
  }
  if (enabledSidebarViews.includes("automations")) {
    defaultMainOptions.push({
      value: "automations",
      label: sidebarViewLabels.automations,
    });
  }
  defaultMainOptions.push({
    value: "settings",
    label: t("virtualMcp.layoutTabContent.settings"),
  });

  const openView = (tabId: string) =>
    openPanel(tabId, { virtualmcpid: virtualMcpId });

  return {
    /** Every view this project can open, in sidebar order. */
    projectViews: availableSidebarViews,
    labels: sidebarViewLabels,
    pinned: (viewId: ProjectSidebarViewId) => sidebarViews.includes(viewId),
    isMainView: (value: string) => defaultMainView === value,
    defaultMainView,
    defaultMainOptions,
    noMainView,
    chatDefaultOpen,
    connectionsData,
    pinnedAppViews: pinnedViews,
    openView,
    togglePin: (viewId: ProjectSidebarViewId, next: boolean) =>
      handleSidebarViewChange(viewId, next),
    setMainView: handleDefaultMainViewChange,
    setChatDefaultOpen: (checked: boolean) => {
      writeLayout({ chatDefaultOpen: checked });
      flushAndSave();
    },
    toggleAppViewPin: handleTogglePin,
    setAppViewIcon: handleIconChange,
    setAppViewLabel: handleLabelChange,
    commitAppViewLabel: handleLabelBlur,
  };
}
