import { useNavigate } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@deco/ui/components/select.tsx";
import { isAutomationsPillActive } from "./tab-id";
import { useMainPanelTabs, type Tab } from "./use-main-panel-tabs";
import { TabIconGlyph } from "./tab-icon-glyph";
import { track } from "@/web/lib/posthog-client";

const MOBILE_SELECT_SENTINEL = "__mobile-main-panel-tab-select__";

export function resolveMobileMainPanelTabSelectLabel({
  tabs,
  activeTab,
  mainOpen,
}: {
  tabs: Array<{ id: string; title: string }>;
  activeTab: string;
  mainOpen: boolean;
}): string {
  const active = tabs.find((tab) => tab.id === activeTab);
  if (mainOpen) return active?.title ?? "Main view";
  return active?.title ?? tabs[0]?.title ?? "Main view";
}

export function MobileMainPanelTabSelect({
  virtualMcpId,
  taskId,
}: {
  virtualMcpId: string;
  taskId: string;
}) {
  const navigate = useNavigate();
  const { tabs, activeTab, mainOpen } = useMainPanelTabs({
    virtualMcpId,
    taskId,
  });
  const label = resolveMobileMainPanelTabSelectLabel({
    tabs,
    activeTab,
    mainOpen,
  });
  const selectedTab =
    tabs.find((tab) => tab.id === activeTab) ?? (!mainOpen ? tabs[0] : null);
  const automationsActive = isAutomationsPillActive({ activeTab, mainOpen });

  const handleSelect = (id: string) => {
    if (id === MOBILE_SELECT_SENTINEL) return;
    const clicked = tabs.find((tab) => tab.id === id);
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: id,
      tab_kind: clicked?.kind ?? null,
      was_active:
        id === "automations" ? automationsActive : mainOpen && activeTab === id,
      source: "mobile_select",
    });
    if (id === "automations") {
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          sidepanel: 0 as const,
          main: "automations",
        }),
        replace: true,
      });
      return;
    }
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        sidepanel: 0 as const,
        main: id,
      }),
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
        aria-label="Main panel tab"
        className="h-10! w-full min-w-0 max-w-[7.5rem] rounded-md border-0 bg-transparent px-1.5 text-xs shadow-none [--card-shadow:none]"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selectedTab && (
            <span className="flex size-4 shrink-0 items-center justify-center">
              <TabIconGlyph icon={selectedTab.icon} />
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
        {tabs.map((tab: Tab) => (
          <SelectItem key={tab.id} value={tab.id}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center">
                <TabIconGlyph icon={tab.icon} />
              </span>
              <span className="min-w-0 truncate">{tab.title}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
