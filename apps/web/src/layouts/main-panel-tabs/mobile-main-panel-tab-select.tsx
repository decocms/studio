import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Columns03,
  Folder,
  LayoutAlt01,
  MessageCircle01,
} from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@decocms/ui/components/select.tsx";
import { getCommerceDiscoveryAgentId, useProjectContext } from "@/sdk";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { mobileSurfaceSearch } from "@/hooks/use-layout-state";
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { usePanelNavigate } from "./use-panel-navigate";
import { shouldDeepLinkSourceTab } from "./source-system-tabs";
import type { TabIcon } from "./resolve-tab-icon";
import { TabIconGlyph } from "./tab-icon-glyph";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

const MOBILE_SELECT_SENTINEL = "__mobile-main-panel-tab-select__";

/** The route's own main surface, for routes that declare no tabs of their own
 *  (the org home is the one people meet first). Not a tab id — nothing opens
 *  it by name; it is the "put the main panel back" half of the mobile pair. */
export const MAIN_SURFACE_VALUE = "main";

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

const CHAT_ICON: TabIcon = { kind: "component", Component: MessageCircle01 };
const TASKS_ICON: TabIcon = { kind: "component", Component: Columns03 };
const LIBRARY_ICON: TabIcon = { kind: "component", Component: Folder };
const MAIN_ICON: TabIcon = { kind: "component", Component: LayoutAlt01 };

/**
 * The surfaces this route can show, in the order the control lists them.
 *
 * The synthetic main-surface row is the fix for a dead end: on a route with no
 * tabs of its own the list was `[Chat]` alone, so tapping Chat left you on a
 * control whose only option was the thing you were already looking at, and the
 * main view was unreachable without the browser's back button. "Main view" was
 * a *label* there, never an option. Where the route does declare tabs, those
 * tabs already are the way back — opening one opens the main panel — so
 * synthesizing another entry beside them would only duplicate the first.
 */
export function buildMobileViewOptions({
  tabs,
  overlayEnabled,
  t,
}: {
  tabs: Array<{ id: string; title: string; icon: TabIcon }>;
  /** Tasks / Library are destinations of their own; they need a task route to
   *  act on (the same gate as the desktop toggles). */
  overlayEnabled: boolean;
  t: ReturnType<typeof useT>;
}): ViewOption[] {
  return [
    {
      value: "chat",
      title: t("mainPanelTabs.mobileMainPanelTabSelect.chat"),
      icon: CHAT_ICON,
    },
    ...(tabs.length > 0
      ? tabs.map((tab) => ({
          value: tab.id,
          title: tab.title,
          icon: tab.icon,
        }))
      : [
          {
            value: MAIN_SURFACE_VALUE,
            title: t("mainPanelTabs.mobileMainPanelTabSelect.mainView"),
            icon: MAIN_ICON,
          },
        ]),
    ...(overlayEnabled
      ? [
          {
            value: "board",
            title: t("mainPanelTabs.mobileMainPanelTabSelect.tasks"),
            icon: TASKS_ICON,
          },
          {
            value: "files",
            title: t("mainPanelTabs.mobileMainPanelTabSelect.library"),
            icon: LIBRARY_ICON,
          },
        ]
      : []),
  ];
}

/**
 * Mobile view selector. On mobile there's no side-by-side split, so a single
 * surface is visible at a time. This mirrors the desktop panel bar — Chat,
 * controls local to the current surface, contextual/per-thread views, and the
 * Tasks / Library overlays. Durable project views stay in the responsive
 * sidebar on both desktop and mobile.
 *
 * Two surfaces get a toggle rather than a dropdown: a menu that opens to offer
 * one alternative is two taps and a list to read where one tap and a label will
 * do. Three or more keep the select, because then "the other one" stops being a
 * thing you can name.
 */
export function MobileMainPanelTabSelect({
  virtualMcpId,
  taskId,
}: {
  virtualMcpId: string;
  taskId: string | null;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { openPanel } = usePanelNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const { tabs, activeTab, mainOpen } = useMainPanelTabs({
    virtualMcpId,
    taskId,
  });
  const { org } = useProjectContext();
  const reportsOnly = useReportsOnly();
  const onReportAgent = virtualMcpId === getCommerceDiscoveryAgentId(org.id);

  const options = buildMobileViewOptions({
    tabs,
    overlayEnabled: !!(params.org && params.taskId),
    t,
  });

  /** Chat while the main panel is closed; else the active tab, or the main
   *  surface itself on a route that declares none. */
  const currentValue = !mainOpen
    ? "chat"
    : (options.find((o) => o.value === activeTab)?.value ?? MAIN_SURFACE_VALUE);
  const selected = options.find((o) => o.value === currentValue);
  const label =
    selected?.title ??
    resolveMobileMainPanelTabSelectLabel({ tabs, activeTab, mainOpen, t });

  /** Both halves of the mobile pair are surface swaps on the same route, so
   *  they write the same pair of params and differ only in which one wins. */
  const showSurface = (surface: "chat" | "main") => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...mobileSurfaceSearch(surface),
      }),
      replace: true,
    });
  };

  const handleSelect = (value: string) => {
    if (value === MOBILE_SELECT_SENTINEL) return;
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: value,
      source: "mobile_select",
    });
    /** Reports-only: the storefront Preview/Code live on the Report Agent, so
     *  from any other shell deep-link into it instead of opening a source-less
     *  panel on the current agent (mirrors setActiveTab in useMainPanelTabs). */
    if (shouldDeepLinkSourceTab({ reportsOnly, onReportAgent, tabId: value })) {
      openPanel(value, {
        virtualmcpid: getCommerceDiscoveryAgentId(org.id),
        /** Another agent's conversation does not follow the view over. */
        search: (prev) => ({ ...prev, thread: undefined, sidepanel: false }),
      });
      return;
    }
    if (value === "chat" || value === MAIN_SURFACE_VALUE) {
      showSurface(value === "chat" ? "chat" : "main");
      return;
    }
    /** The view is the path now, so only the chat half needs writing: naming a
     *  view is what opens the main panel. */
    openPanel(value, {
      search: (prev) => ({ ...prev, sidepanel: false }),
    });
  };

  /** The one this control would switch you to — only meaningful in the two-
   *  option case; with a longer list there is no single "other". */
  const other = options.find((option) => option.value !== currentValue);

  if (options.length === 2 && other) {
    return (
      <button
        type="button"
        onClick={() => handleSelect(other.value)}
        aria-label={t("mainPanelTabs.mobileMainPanelTabSelect.switchTo", {
          name: other.title,
        })}
        /* Sized and padded like the trigger it replaces, so swapping the
           control does not move the strip it sits in. */
        className="flex h-10 min-w-0 max-w-[7.5rem] items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <TabIconGlyph icon={other.icon} className="size-5" />
        </span>
        <span className="min-w-0 truncate">{other.title}</span>
      </button>
    );
  }

  return (
    <Select value={MOBILE_SELECT_SENTINEL} onValueChange={handleSelect}>
      {/*
        Clean, borderless trigger: the SelectTrigger's default box-shadow
        "border" is the `card-shadow` utility, which reads var(--card-shadow).
        We null that variable on this element (`[--card-shadow:none]`) instead
        of `card-shadow-none`, which is not a real utility.
      */}
      <SelectTrigger
        aria-label={t("mainPanelTabs.mobileMainPanelTabSelect.view")}
        className="h-10! w-full min-w-0 max-w-[7.5rem] rounded-md border-0 bg-transparent px-1.5 text-xs shadow-none [--card-shadow:none]"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selected && (
            <span className="flex size-5 shrink-0 items-center justify-center">
              <TabIconGlyph icon={selected.icon} className="size-5" />
            </span>
          )}
          <span className="min-w-0 truncate">{label}</span>
        </span>
      </SelectTrigger>
      <SelectContent align="end" className="w-56">
        <SelectItem
          value={MOBILE_SELECT_SENTINEL}
          disabled
          hideCheck
          className="hidden"
        >
          {label}
        </SelectItem>
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
