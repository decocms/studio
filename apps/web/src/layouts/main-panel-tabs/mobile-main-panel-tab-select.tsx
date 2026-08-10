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
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { shouldDeepLinkSourceTab } from "./source-system-tabs";
import type { TabIcon } from "./resolve-tab-icon";
import { TabIconGlyph } from "./tab-icon-glyph";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

const MOBILE_SELECT_SENTINEL = "__mobile-main-panel-tab-select__";

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

/**
 * Mobile view selector. On mobile there's no side-by-side split, so a single
 * surface is visible at a time — this dropdown therefore holds *everything* the
 * desktop spreads across the toolbar: Chat, the agent's main views (Overview,
 * Preview, …), plus the agent-independent Tasks / Library overlays. Picking any
 * option swaps the single visible surface (chat closes the main panel; the rest
 * open the main panel on that view and close chat).
 */
export function MobileMainPanelTabSelect({
  virtualMcpId,
  taskId,
}: {
  virtualMcpId: string;
  taskId: string;
}) {
  const t = useT();
  const navigate = useNavigate();
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

  // Tasks / Library are toggled via `?main=board|files`; they need a task route
  // to act on (same gate as the desktop toggles).
  const overlayEnabled = !!(params.org && params.taskId);

  const options: ViewOption[] = [
    {
      value: "chat",
      title: t("mainPanelTabs.mobileMainPanelTabSelect.chat"),
      icon: CHAT_ICON,
    },
    ...tabs.map((tab) => ({
      value: tab.id,
      title: tab.title,
      icon: tab.icon,
    })),
    ...(overlayEnabled
      ? [
          {
            value: "board",
            title: t("mainPanelTabs.mobileMainPanelTabSelect.tasks"),
            icon: TASKS_ICON,
          },
        ]
      : []),
    ...(overlayEnabled
      ? [
          {
            value: "files",
            title: t("mainPanelTabs.mobileMainPanelTabSelect.library"),
            icon: LIBRARY_ICON,
          },
        ]
      : []),
  ];

  // Chat is the surface whenever the main panel is closed; otherwise the active
  // main tab (which includes board/files when an overlay is open).
  const currentValue = !mainOpen
    ? "chat"
    : (options.find((o) => o.value === activeTab)?.value ?? activeTab);
  const selected = options.find((o) => o.value === currentValue);
  const label =
    selected?.title ??
    resolveMobileMainPanelTabSelectLabel({ tabs, activeTab, mainOpen, t });

  const handleSelect = (value: string) => {
    if (value === MOBILE_SELECT_SENTINEL) return;
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: value,
      source: "mobile_select",
    });
    // Reports-only: the storefront Preview/Code live on the Report Agent, so
    // from any other shell deep-link into it instead of opening a source-less
    // panel on the current agent (mirrors setActiveTab in useMainPanelTabs).
    if (shouldDeepLinkSourceTab({ reportsOnly, onReportAgent, tabId: value })) {
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId: crypto.randomUUID() },
        search: {
          virtualmcpid: getCommerceDiscoveryAgentId(org.id),
          main: value,
        },
      });
      return;
    }
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) =>
        value === "chat"
          ? { ...prev, sidepanel: "chat" as const, main: 0 as const }
          : { ...prev, sidepanel: 0 as const, main: value },
      replace: true,
    });
  };

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
