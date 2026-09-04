import { useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Columns03, Folder, MessageCircle01 } from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@decocms/ui/components/select.tsx";
import { getCommerceDiscoveryAgentId, useProjectContext } from "@/sdk";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import {
  mobileSurfaceSearch,
  resolveMobileSurface,
  type MobileWorkspaceSurface,
} from "@/hooks/use-layout-state";
import { useWorkspace } from "@/layouts/agent-shell-layout/workspace-context";
import { useMainPanelTabs } from "./main-panel-tabs-context";
import { usePanelNavigate } from "./use-panel-navigate";
import { shouldDeepLinkSourceTab } from "./source-system-tabs";
import type { TabIcon } from "./resolve-tab-icon";
import { TabIconGlyph } from "./tab-icon-glyph";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import { useRouteMainTitle } from "@/hooks/use-route-main-title";
import { useScopeId } from "@/hooks/use-project-scope";

export function resolveMobileMainPanelTabSelectLabel({
  tabs,
  activeTab,
  mainOpen,
  t,
}: {
  tabs: Array<{ id: string; title: string }>;
  activeTab: string;
  mainOpen: boolean;
  t: ReturnType<typeof useT>;
}): string {
  const active = tabs.find((tab) => tab.id === activeTab);
  const defaultLabel = t("mainPanelTabs.mobileMainPanelTabSelect.mainView");
  if (mainOpen) return active?.title ?? defaultLabel;
  return active?.title ?? tabs[0]?.title ?? defaultLabel;
}

type ViewOption = { value: string; title: string; icon: TabIcon };

export function resolveMobileMainPanelTriggerOption({
  options,
  value,
}: {
  options: readonly ViewOption[];
  value: string;
}): ViewOption | undefined {
  return options.find((option) => option.value === value);
}

const CHAT_ICON: TabIcon = { kind: "component", Component: MessageCircle01 };
const TASKS_ICON: TabIcon = { kind: "component", Component: Columns03 };
const LIBRARY_ICON: TabIcon = { kind: "component", Component: Folder };

export function resolveMobileMainPanelViewOptions({
  tabs,
  activeTab,
  currentRouteTitle,
  orgSlug,
  projectScoped = false,
  titles,
}: {
  tabs: Array<{ id: string; title: string; icon: TabIcon }>;
  activeTab: string;
  currentRouteTitle?: string;
  orgSlug: string | undefined;
  projectScoped?: boolean;
  titles: { chat: string; tasks: string; library: string; mainView: string };
}): ViewOption[] {
  const chatOption = {
    value: "chat",
    title: titles.chat,
    icon: CHAT_ICON,
  } satisfies ViewOption;
  const routeOptions: ViewOption[] = [
    ...tabs.map((tab) => ({
      value: tab.id,
      title: tab.title,
      icon: tab.icon,
    })),
    ...(orgSlug
      ? [
          { value: "board", title: titles.tasks, icon: TASKS_ICON },
          ...(projectScoped
            ? []
            : [{ value: "files", title: titles.library, icon: LIBRARY_ICON }]),
        ]
      : []),
  ];
  const currentRouteOption =
    activeTab !== "chat" &&
    !routeOptions.some(({ value }) => value === activeTab)
      ? [
          {
            value: activeTab,
            title: currentRouteTitle ?? titles.mainView,
            icon: { kind: "fallback" },
          } satisfies ViewOption,
        ]
      : [];
  return [chatOption, ...currentRouteOption, ...routeOptions];
}

export function resolveMobileMainPanelSelection(input: {
  activeTab: string;
  sidePanelOpen: boolean;
  mainOpen: boolean;
  sidePanelParamPresent: boolean;
}): { value: string; surface: MobileWorkspaceSurface } {
  const surface = resolveMobileSurface({
    visibility: {
      sidePanelOpen: input.sidePanelOpen,
      mainOpen: input.mainOpen,
    },
    sidePanelParamPresent: input.sidePanelParamPresent,
  });
  return {
    value: surface === "chat" ? "chat" : input.activeTab,
    surface,
  };
}

/** Reveal the Main surface without re-navigating its route. The route remains
 * matched while Chat wins on mobile, so all route-owned state (a task card,
 * filters, or a Content deep link) must remain byte-for-byte intact. */
export function restoreCurrentMobileMainSearch(
  previous: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...previous, ...mobileSurfaceSearch("main") };
}

/**
 * Mobile view selector. On mobile there's no side-by-side split, so a single
 * surface is visible at a time. This dropdown mirrors the desktop panel bar —
 * Chat, controls local to the current surface, contextual/per-thread views, and
 * Tasks plus the organization Library when unscoped. Project workspaces omit
 * Library here for the same reason their sidebar does: it is not a project
 * destination. Durable project views stay in the responsive sidebar.
 */
export function MobileMainPanelTabSelect({
  currentRouteTitle,
}: {
  /** Label for a route that is not one of the contextual project tabs. */
  currentRouteTitle?: string;
}) {
  const t = useT();
  const inheritedRouteTitle = useRouteMainTitle();
  const navigate = useNavigate();
  const { openPanel } = usePanelNavigate();
  const params = useParams({ strict: false });
  const orgSlug =
    "org" in params && typeof params.org === "string" ? params.org : undefined;
  const projectScoped = useScopeId() !== null;
  const { virtualMcpId, tabs, activeTab, activeRouteTitle } =
    useMainPanelTabs();
  const workspace = useWorkspace();
  const { org } = useProjectContext();
  const reportsOnly = useReportsOnly();
  const onReportAgent = virtualMcpId === getCommerceDiscoveryAgentId(org.id);
  // A path replacement hands focus to the destination heading; suppress the
  // select primitive's competing attempt to restore its departing trigger.
  const routeChangeOwnsFocus = useRef(false);

  // Tasks exists at both organization and project scope; Library is org-only.
  // Selecting either clears the active thread, so availability must not
  // depend on `taskId`.
  const options = resolveMobileMainPanelViewOptions({
    tabs,
    activeTab,
    currentRouteTitle:
      currentRouteTitle ?? inheritedRouteTitle ?? activeRouteTitle,
    orgSlug,
    projectScoped,
    titles: {
      chat: t("mainPanelTabs.mobileMainPanelTabSelect.chat"),
      tasks: t("mainPanelTabs.mobileMainPanelTabSelect.tasks"),
      library: t("mainPanelTabs.mobileMainPanelTabSelect.library"),
      mainView: t("mainPanelTabs.mobileMainPanelTabSelect.mainView"),
    },
  });

  const selection = resolveMobileMainPanelSelection({
    activeTab,
    sidePanelOpen: workspace.sidePanelOpen,
    mainOpen: workspace.mainOpen,
    sidePanelParamPresent: workspace.sidePanelParamPresent,
  });
  const currentValue = selection.value;
  const triggerOption = resolveMobileMainPanelTriggerOption({
    options,
    value: currentValue,
  });
  const label =
    triggerOption?.title ??
    resolveMobileMainPanelTabSelectLabel({
      tabs,
      activeTab,
      mainOpen: selection.surface === "main",
      t,
    });

  const handleSelect = (value: string) => {
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: value,
      source: "mobile_select",
    });
    // Reports-only: the storefront Preview/Code live on the Report Agent, so
    // from any other shell deep-link into it instead of opening a source-less
    // panel on the current agent (mirrors setActiveTab in useMainPanelTabs).
    if (shouldDeepLinkSourceTab({ reportsOnly, onReportAgent, tabId: value })) {
      routeChangeOwnsFocus.current = true;
      openPanel(value, {
        agentId: getCommerceDiscoveryAgentId(org.id),
        /** Another agent's conversation does not follow the view over. */
        search: (prev) => ({ ...prev, thread: undefined, sidepanel: false }),
      });
      return;
    }
    if (value === "chat") {
      routeChangeOwnsFocus.current = false;
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          ...mobileSurfaceSearch("chat"),
        }),
        replace: true,
      });
      return;
    }
    if (selection.surface === "chat" && value === activeTab) {
      routeChangeOwnsFocus.current = false;
      navigate({
        to: ".",
        search: restoreCurrentMobileMainSearch,
        replace: true,
      });
      return;
    }
    /** The view is the path now, so only the chat half needs writing: naming a
     *  view is what opens the main panel. */
    routeChangeOwnsFocus.current = value !== activeTab;
    openPanel(value, {
      search: (prev) => ({ ...prev, sidepanel: false }),
    });
  };

  return (
    <Select value={currentValue} onValueChange={handleSelect}>
      {/*
        Clean, borderless trigger: the SelectTrigger's default box-shadow
        "border" is the `card-shadow` utility, which reads var(--card-shadow).
        We null that variable on this element (`[--card-shadow:none]`) instead
        of `card-shadow-none`, which is not a real utility.
      */}
      <SelectTrigger
        data-route-focus-source="mobile-view-select"
        data-responsive-focus-group="main-route-navigation"
        aria-label={t("mainPanelTabs.mobileMainPanelTabSelect.view")}
        className="h-10! w-full min-w-0 max-w-[7.5rem] rounded-md border-0 bg-transparent px-1.5 text-xs shadow-none [--card-shadow:none]"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {triggerOption && (
            <span className="flex size-5 shrink-0 items-center justify-center">
              <TabIconGlyph icon={triggerOption.icon} className="size-5" />
            </span>
          )}
          <span className="min-w-0 truncate">{label}</span>
        </span>
      </SelectTrigger>
      <SelectContent
        data-route-focus-source="mobile-view-select"
        align="end"
        className="w-56"
        onCloseAutoFocus={(event) => {
          if (routeChangeOwnsFocus.current) event.preventDefault();
          routeChangeOwnsFocus.current = false;
        }}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center">
                <TabIconGlyph icon={option.icon} />
              </span>
              <span className="min-w-0 truncate">{option.title}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
